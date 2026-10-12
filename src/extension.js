// extension.js — Codebase Index & C/C++ Jump VS Code 扩展入口
// 职责：注册命令，整合 clangd-client（C/C++ 搜索跳转）与 semantic-index（codebase 语义检索 + Merkle 增量）
// 环境：Windows + VS Code，代码/编译工具在 Linux 服务器，网络挂载为 X 盘（慢速网络盘）
// 依赖：vscode API + ./clangd-client + ./semantic-index
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { ClangdClient } = require('./clangd-client');
const { SemanticIndex } = require('./semantic-index');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);

async function activate(context) {
  console.log('codebase-index 扩展已激活');

  let clangd = null;
  let semIndex = null;

  // 按需获取 clangd 客户端（C/C++ 搜索跳转）
  async function getClangd() {
    if (clangd) return clangd;
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const cwd = ws ? ws.uri.fsPath : process.cwd();
    const cfg = vscode.workspace.getConfiguration('codebaseIndex');
    const clangdPath = cfg.get('clangdPath') || 'clangd';
    clangd = new ClangdClient(clangdPath, cwd);
    try {
      await clangd.start();
    } catch (e) {
      vscode.window.showErrorMessage('clangd 不可用: ' + e.message);
      return null;
    }
    return clangd;
  }

  // 按需获取语义索引（codebase 检索 + Merkle 增量）
  async function getSemIndex(root) {
    if (semIndex) return semIndex;
    const cfg = vscode.workspace.getConfiguration('codebaseIndex');
    const opts = {
      embeddingModel: cfg.get('embeddingModel') || 'jinaai/jina-embeddings-v2-base-code',
      workspaceRoot: root || null,
      proxy: cfg.get('embeddingProxy') || null,
    };
    semIndex = new SemanticIndex(opts);
    await semIndex.init();
    return semIndex;
  }

  // 收集 C/C++ 文件（健壮：网络挂载盘（X 盘）上目录可能不可读，逐个 try/catch）
  function collectFiles(root) {
    const files = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; } // 网络盘上不可读目录跳过
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') continue;
            walk(p);
          } else if (/\.(c|cpp|cc|cxx|h|hpp)$/i.test(entry.name)) {
            files.push(p);
          }
        } catch {}
      }
    };
    walk(root);
    return files;
  }

  // ---- 命令1: 索引工作区（Merkle 增量）----
  const indexCmd = vscode.commands.registerCommand('codebaseIndex.indexWorkspace', async () => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) { vscode.window.showInformationMessage('请先打开一个文件夹'); return; }
    const root = ws.uri.fsPath;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Codebase 索引中...' }, async (progress) => {
      const idx = await getSemIndex(root);
      const files = collectFiles(root);
      // Merkle 增量（目录级子树哈希快速跳过未变目录 + 文件级精确跳过未变文件，避免重扫慢速 X 盘）
      const detectLang = (f) => (/\.(c)$/i.test(f) ? 'c' : 'cpp');
      const stats = await idx.incrementalIndex(files, detectLang, ({ doneDirs, totalDirs, stats: s }) => {
        progress.report({ message: `处理目录 ${doneDirs}/${totalDirs}, 新增 ${s.indexed}, 未变 ${s.unchanged}, 共 ${idx.store ? idx.store.count() : idx.chunks.length} 块` });
      });
      const total = files.length;
      vscode.window.showInformationMessage(
        `索引完成: 扫描 ${total} 文件, 覆盖目录 ${Object.keys(idx.dirMerkle).length} 个, ` +
        `新增/变化 ${stats.indexed}, 未变 ${stats.unchanged}, 整目录跳过 ${stats.dirsSkipped}, 共 ${idx.store ? idx.store.count() : idx.chunks.length} 代码块`
      );
    });
  });

  // ---- 命令2: 语义搜索 ----
  const semCmd = vscode.commands.registerCommand('codebaseIndex.semanticSearch', async () => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const idx = await getSemIndex(ws ? ws.uri.fsPath : null);
    const hasIndex = idx.store ? idx.store.count() > 0 : idx.chunks.length > 0;
    if (!hasIndex) {
      vscode.window.showWarningMessage('请先运行 "Codebase Index: 索引工作区"');
      return;
    }
    const query = await vscode.window.showInputBox({ prompt: '输入自然语言查询（如：计算阶乘的函数）', placeHolder: '语义搜索代码...' });
    if (!query) return;
    const results = await idx.search(query, 5);
    const items = results.map((r) => ({
      label: `${r.path.split(/[\\/]/).pop()}:${r.start}`,
      description: r.content.split('\n')[0].slice(0, 60),
      detail: `相似度 ${r.score}`,
      r,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `“${query}” 的语义搜索结果` });
    if (picked) {
      const doc = await vscode.workspace.openTextDocument(picked.r.path);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(picked.r.start - 1, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    }
  });

  // ---- 命令3: 符号搜索 (C/C++) ----
  const symCmd = vscode.commands.registerCommand('codebaseIndex.searchSymbol', async () => {
    const client = await getClangd();
    if (!client) return;
    const query = await vscode.window.showInputBox({ prompt: '输入符号名（如 add / factorial）' });
    if (!query) return;
    const syms = await client.searchSymbol(query);
    if (!syms.length) { vscode.window.showInformationMessage('未找到符号'); return; }
    const items = syms.map((s) => ({
      label: s.name,
      description: s.containerName,
      detail: s.location.uri,
      loc: s.location,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${syms.length} 个符号匹配` });
    if (picked) {
      const uri = vscode.Uri.parse(picked.loc.uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(picked.loc.range.start.line, picked.loc.range.start.character);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    }
  });

  // ---- 命令4: 跳转到定义 (C/C++) ----
  const defCmd = vscode.commands.registerCommand('codebaseIndex.goToDefinition', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const client = await getClangd();
    if (!client) return;
    const uri = editor.document.uri.toString();
    const { line, character } = editor.selection.active;
    await client.openDocument(editor.document.uri.toString(), editor.document.getText(), editor.document.languageId);
    const defs = await client.goToDefinition(uri, line, character);
    if (!defs || !defs.length) { vscode.window.showInformationMessage('无定义'); return; }
    const d = Array.isArray(defs) ? defs[0] : defs;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(d.uri || d.targetUri));
    const ed = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position((d.range?.start || d.targetSelectionRange?.start).line, (d.range?.start || d.targetSelectionRange?.start).character);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos));
  });

  // ---- 命令5: 全文搜索 (ripgrep，复刻 Cursor 本地全文搜索) ----
  const textCmd = vscode.commands.registerCommand('codebaseIndex.textSearch', async () => {
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!ws) { vscode.window.showInformationMessage('请先打开一个文件夹'); return; }
    const root = ws.uri.fsPath;
    const query = await vscode.window.showInputBox({ prompt: '输入要全文搜索的文本/正则' });
    if (!query) return;
    try {
      const { stdout } = await execFileP('rg', ['-n', '--max-count', '5', query, root]);
      const lines = stdout.split('\n').filter(Boolean);
      if (!lines.length) { vscode.window.showInformationMessage('无匹配'); return; }
      const items = lines.map(l => {
        const m = l.match(/^([^:]+):(\d+):(.*)$/);
        return { label: (m ? m[1].split(/[\\/]/).pop() : l), description: (m ? `行${m[2]}` : ''), detail: (m ? m[3].slice(0, 60) : ''), line: m ? +m[2] : 0, file: m ? m[1] : '' };
      });
      const picked = await vscode.window.showQuickPick(items, { placeHolder: `“${query}” 全文搜索结果` });
      if (picked && picked.file) {
        const doc = await vscode.workspace.openTextDocument(picked.file);
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(picked.line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    } catch (e) {
      vscode.window.showErrorMessage('全文搜索失败: ' + e.message);
    }
  });

  context.subscriptions.push(indexCmd, semCmd, symCmd, defCmd, textCmd);
}

function deactivate() {}

module.exports = { activate, deactivate };
