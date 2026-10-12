// semantic-index.js — Cursor codebase-indexing 本地复刻（语义检索引擎 + Merkle 增量索引）
// 职责：tree-sitter 语法感知分块 + 代码专用 embedding + 余弦 KNN 检索 + Merkle 增量同步
// 调用方：extension.js（indexWorkspace / semanticSearch 命令）
// 依赖：web-tree-sitter（分块）、@huggingface/transformers（代码专用 embedding）、node:crypto
// 红线：
//   - embedding 必须用代码专用模型（jina-code），通用模型（gte/bge）检索精度差（PoC 实测 2/4 vs 4/4）
//   - Merkle 增量：只在文件哈希变化时重新索引，避免全量扫描慢速网络挂载盘（X 盘）
//   - 首次索引走全量；后续走增量（对比文件 SHA-256，只处理新增/修改）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// tree-sitter 语言 wasm 路径（按需注册）
const LANG_WASM = {
  c: 'tree-sitter-c/tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp/tree-sitter-cpp.wasm',
};
// 需要切块的语言顶层节点类型（函数/类/结构体/宏）
const CHUNK_TYPES = {
  c: new Set(['function_definition','struct_specifier','enum_specifier','union_specifier','preproc_def','preproc_function_def','typedef']),
  cpp: new Set(['function_definition','class_specifier','struct_specifier','enum_specifier','union_specifier','preproc_def','preproc_function_def','template_declaration','field_declaration']),
};
// 容器节点（namespace 等）：深入遍历，不作为块边界
const CONTAINERS = new Set(['namespace_definition', 'translation_unit']);

class SemanticIndex {
  constructor(opts) {
    opts = opts || {};
    // 代码专用 embedding：jina-code（768 维，命中率 4/4）；备选 bge-m3（通用，3/4）
    this.embeddingModel = opts.embeddingModel || 'jinaai/jina-embeddings-v2-base-code';
    this.embeddingBackup = 'Xenova/bge-m3';
    this.workspaceRoot = opts.workspaceRoot || null;
    this.proxy = opts.proxy || null;
    this.chunks = [];      // 内存中的已索引块（含 vec）
    this.merkleState = {}; // { filePath: sha256 }
    this.parser = null;
    this._Parser = null;
    this.langs = {};
    this.statusFile = null;
  }

  async init() {
    // 可选代理（Windows 网络环境下载 embedding 模型用）
    if (this.proxy) {
      try {
        const { setGlobalDispatcher, ProxyAgent } = require('undici');
        setGlobalDispatcher(new ProxyAgent(this.proxy));
      } catch (e) { console.warn('设置 embedding 代理失败:', e.message); }
    }
    const { Parser } = require('web-tree-sitter');
    await Parser.init();
    this.parser = new Parser();
    this._Parser = Parser;
    // transformers.js v3 + 代码专用 embedding
    const { pipeline, env } = require('@huggingface/transformers');
    env.allowLocalModels = false;
    try {
      this.embedder = await pipeline('feature-extraction', this.embeddingModel);
    } catch (e) {
      // 主模型不可用（如网络/权限）→ 回退到通用 bge-m3
      console.warn(`embedding 主模型 ${this.embeddingModel} 加载失败，回退 ${this.embeddingBackup}: ${e.message}`);
      this.embedder = await pipeline('feature-extraction', this.embeddingBackup);
    }
    // 状态文件（Merkle 增量持久化）
    if (this.workspaceRoot) {
      const stateDir = path.join(this.workspaceRoot, '.codebase-index');
      fs.mkdirSync(stateDir, { recursive: true });
      this.statusFile = path.join(stateDir, 'merkle-state.json');
      this._loadMerkleState();
    }
  }

  _loadMerkleState() {
    try {
      if (this.statusFile && fs.existsSync(this.statusFile)) {
        const data = JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
        this.merkleState = data.merkle || {};
        // 恢复持久化的向量块（避免重启后重新 embedding）
        if (Array.isArray(data.chunks)) this.chunks = data.chunks;
      }
    } catch { this.merkleState = {}; }
  }

  _saveMerkleState() {
    try {
      if (this.statusFile) {
        fs.writeFileSync(this.statusFile, JSON.stringify({ merkle: this.merkleState, chunks: this.chunks }, null, 1));
      }
    } catch (e) { console.warn('保存索引状态失败:', e.message); }
  }

  // 文件内容 SHA-256（Merkle 叶子哈希）
  _fileHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // 目录 Merkle 哈希（子项哈希排序后组合哈希；用于判断目录是否变化）
  _dirHash(entries) {
    const h = crypto.createHash('sha256');
    for (const e of entries.sort()) h.update(e);
    return h.digest('hex');
  }

  async _loadLang(lang) {
    if (this.langs[lang]) return this.langs[lang];
    const wasm = LANG_WASM[lang];
    if (!wasm) return null;
    const wasmPath = path.join(path.dirname(require.resolve('tree-sitter-c/package.json')), '..', wasm);
    const { Language } = require('web-tree-sitter');
    this.langs[lang] = await Language.load(wasmPath);
    return this.langs[lang];
  }

  async _embed(text) {
    const out = await this.embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }

  _cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // 对单个文件做 tree-sitter 分块 + embedding（返回新块数组）
  async _chunkAndEmbed(filePath, lang) {
    const langObj = await this._loadLang(lang);
    if (!langObj) return [];
    const src = fs.readFileSync(filePath, 'utf8');
    this.parser.setLanguage(langObj);
    const tree = this.parser.parse(src);
    const root = tree.rootNode;
    const types = CHUNK_TYPES[lang] || CHUNK_TYPES.c;
    const nodes = [];
    const walk = (node) => {
      if (CONTAINERS.has(node.type)) { for (const c of node.children) walk(c); return; }
      if (types.has(node.type)) { nodes.push(node); return; }
      for (const c of node.children) walk(c);
    };
    walk(root);
    const out = [];
    for (const n of nodes) {
      const content = src.slice(n.startIndex, n.endIndex).trim();
      if (!content || content.length < 8) continue;
      const vec = await this._embed(content);
      out.push({
        id: 0, path: filePath, lang,
        start: n.startPosition.row + 1, end: n.endPosition.row + 1,
        content, vec,
      });
    }
    return out;
  }

  // 移除某文件的所有块（Merkle 删除时）
  _removeFileChunks(filePath) {
    this.chunks = this.chunks.filter(c => c.path !== filePath);
  }

  // 索引一个文件（更新内存 + Merkle 状态）。返回新增块数。
  async indexFile(filePath, lang) {
    let src;
    try { src = fs.readFileSync(filePath, 'utf8'); } catch { return 0; }
    const hash = this._fileHash(src);
    const oldHash = this.merkleState[filePath];
    const inMemory = this.chunks.some(c => c.path === filePath);
    // Merkle 增量：哈希未变且内存中已有该文件块 → 跳过（避免重扫慢速网络盘）
    // 但重启后内存为空时，即使哈希未变也需重建内存块（否则 chunks 永远空）
    if (oldHash === hash && inMemory) return 0;
    // 移除旧块，重新分块+embedding
    this._removeFileChunks(filePath);
    const newChunks = await this._chunkAndEmbed(filePath, lang);
    for (const c of newChunks) { c.id = this.chunks.length; this.chunks.push(c); }
    this.merkleState[filePath] = hash;
    this._saveMerkleState();
    return newChunks.length;
  }

  // 移除一个已删除的文件（Merkle 删除路径）
  removeFile(filePath) {
    this._removeFileChunks(filePath);
    if (this.merkleState[filePath]) {
      delete this.merkleState[filePath];
      this._saveMerkleState();
    }
  }

  // 增量索引：对给定文件列表，只处理 Merkle 变化的部分。返回统计。
  // 说明：Merkle 树是「文件哈希字典」，目录树哈希用于可选的整体校验；此处用文件级哈希做增量，
  //       避免全量重扫慢速网络挂载盘（X 盘）。返回 {indexed, unchanged, removed, chunks}
  async incrementalIndex(fileList, detectLang) {
    const stats = { indexed: 0, unchanged: 0, removed: 0, chunks: 0 };
    const seen = new Set();
    for (const f of fileList) {
      seen.add(f);
      const lang = detectLang ? detectLang(f) : (f.endsWith('.c') ? 'c' : 'cpp');
      const n = await this.indexFile(f, lang);
      if (n === 0) {
        // n===0 可能是「未变化」或「无块」；区分：查 Merkle 是否有该文件记录
        if (this.merkleState[f]) stats.unchanged++;
        else stats.indexed++; // 新增但无块（空文件等）
      } else { stats.indexed++; stats.chunks += n; }
    }
    // Merkle 清理：删除不在列表中的文件
    for (const f of Object.keys(this.merkleState)) {
      if (!seen.has(f)) { this.removeFile(f); stats.removed++; }
    }
    return stats;
  }

  // 语义搜索：query → embedding → KNN 余弦 → 返回最相关块（按文件聚合，避免声明/定义重复）
  async search(query, topK = 5) {
    const qv = await this._embed(query);
    const scored = this.chunks
      .map((c) => ({ ...c, score: this._cosine(qv, c.vec) }))
      .sort((a, b) => b.score - a.score);
    // 按文件聚合：同一文件只保留最高分块（Cursor 返回路径+行号，用户按文件跳转）
    const byFile = new Map();
    for (const c of scored) {
      if (!byFile.has(c.path) || c.score > byFile.get(c.path).score) {
        byFile.set(c.path, c);
      }
    }
    return Array.from(byFile.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ score, ...rest }) => ({ ...rest, score: Number(score.toFixed(4)) }));
  }
}

module.exports = { SemanticIndex };
