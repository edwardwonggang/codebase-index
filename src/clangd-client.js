// clangd-client.js — C/C++ 搜索与跳转（通过 clangd LSP 协议）
// 职责：spawn clangd 二进制，走 JSON-RPC over stdio，
//       提供 workspace/symbol（符号搜索）与 textDocument/definition（定义跳转）。
// 调用方：extension.js
// 依赖：child_process（spawn clangd）
// 红线：clangd 是外部二进制，失败时须降级为 "clangd 不可用" 提示，不崩溃扩展。
const { spawn } = require('node:child_process');

class ClangdClient {
  constructor(clangdPath, cwd) {
    this.clangdPath = clangdPath || 'clangd';
    this.cwd = cwd;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve,reject}
    this.buffer = '';
    this.rootUri = 'file://' + cwd;
  }

  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.clangdPath, ['--background-index', '--compile-commands-dir=.', '--log=error'], {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (e) { return reject(e); }

      this.proc.stdout.on('data', (d) => {
        this.buffer += d.toString();
        // 按 Content-Length 帧解析 LSP 消息
        let idx;
        while ((idx = this.buffer.indexOf('\r\n\r\n')) !== -1) {
          const header = this.buffer.slice(0, idx);
          const m = /Content-Length: (\d+)/i.exec(header);
          if (!m) { this.buffer = this.buffer.slice(idx + 4); continue; }
          const len = parseInt(m[1], 10);
          const bodyStart = idx + 4;
          if (this.buffer.length < bodyStart + len) break;
          const body = this.buffer.slice(bodyStart, bodyStart + len);
          this.buffer = this.buffer.slice(bodyStart + len);
          this._handleMessage(body);
        }
      });
      this.proc.stderr.on('data', () => {}); // 吞掉 clangd 日志
      this.proc.on('error', (e) => reject(e));

      // 初始化握手
      this._send('initialize', {
        processId: process.pid,
        rootUri: this.rootUri,
        capabilities: { textDocument: { synchronization: { didOpen: true } } }
      }).then(() => {
        this._notify('initialized', {});
        resolve();
      }).catch(reject);
    });
  }

  _handleMessage(body) {
    let msg;
    try { msg = JSON.parse(body); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }

  _send(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const framed = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    this.proc.stdin.write(framed);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  // 发送 LSP 通知（无响应，如 didOpen / initialized）
  _notify(method, params) {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    const framed = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    this.proc.stdin.write(framed);
  }

  // 打开文件（让 clangd 建立 AST/索引）
  async openDocument(uri, text, languageId) {
    this._notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageId || 'cpp', version: 1, text }
    });
  }

  // workspace/symbol — 按符号名搜索（符号索引）
  async searchSymbol(query) {
    const res = await this._send('workspace/symbol', { query });
    return (res || []).map((s) => ({
      name: s.name,
      kind: s.kind,
      containerName: s.containerName,
      location: s.location,
    }));
  }

  // textDocument/definition — 定义跳转
  async goToDefinition(uri, line, character) {
    const res = await this._send('textDocument/definition', {
      textDocument: { uri },
      position: { line, character }
    });
    return res;
  }

  async stop() {
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill();
  }
}

module.exports = { ClangdClient };
