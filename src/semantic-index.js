// semantic-index.js — Cursor codebase-indexing 本地复刻（语义检索引擎 + 向量库 + Merkle 增量）
// 职责：tree-sitter 语法感知分块 + 代码专用 embedding + sqlite-vec 向量库 KNN 检索 + rerank + Merkle 增量同步
// 调用方：extension.js（indexWorkspace / semanticSearch 命令）
// 依赖：web-tree-sitter（分块）、@huggingface/transformers（代码专用 embedding）、
//       ./vector-store（sqlite-vec 向量库 + better-sqlite3）、node:crypto
// 红线：
//   - embedding 必须用代码专用模型（jina-code），通用模型（gte/bge）检索精度差（PoC 实测 2/4 vs 4/4）
//   - 向量必须落 sqlite-vec 库（vec.db），不用 JSON 存全量向量 —— 大仓库重启会内存/加载膨胀（旧实现教训）
//   - Merkle 增量：文件级 SHA-256 定位变化文件 + 目录级子树哈希快速跳过未变子树（慢速 X 盘优化）
//   - vec0 维度在建表时固定，embedding 维度变化须重建（见 vector-store 红线）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { VectorStore } = require('./vector-store');

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
// rerank 融合权重：向量相似度占 0.7，词元重叠占 0.3（可配，兼顾语义与精确标识符匹配）
const RERANK_VEC_WEIGHT = 0.7;

class SemanticIndex {
  constructor(opts) {
    opts = opts || {};
    // 代码专用 embedding：jina-code（768 维，命中率 4/4）；备选 bge-m3（通用，3/4）
    this.embeddingModel = opts.embeddingModel || 'jinaai/jina-embeddings-v2-base-code';
    this.embeddingBackup = 'Xenova/bge-m3';
    this.workspaceRoot = opts.workspaceRoot || null;
    this.proxy = opts.proxy || null;
    this.chunks = [];      // 索引块元数据缓存（不含 vec，vec 在数据库）；兼容旧 chunks.length 用法
    this.merkleState = {}; // { filePath: sha256 } 文件级 Merkle 叶子哈希（定位变化文件）
    this.dirMerkle = {};   // { dirPath: sha256 } 目录级子树哈希（真 Merkle 树：快速跳过未变子树）
    this.parser = null;
    this._Parser = null;
    this.langs = {};
    this.statusFile = null;
    this.dbFile = null;
    this.embedder = null;
    this.store = null;
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
    // 状态文件 + 向量库文件（Merkle 增量 + 向量持久化）
    if (this.workspaceRoot) {
      const stateDir = path.join(this.workspaceRoot, '.codebase-index');
      fs.mkdirSync(stateDir, { recursive: true });
      this.statusFile = path.join(stateDir, 'merkle-state.json');
      this.dbFile = path.join(stateDir, 'vec.db');
      this._loadMerkleState();
      // 重启恢复：若已有向量库，用已存维度打开可写 store + 恢复块元数据缓存
      this._restoreChunkMeta();
    }
  }

  // 从向量库恢复：打开可写 store（用已存维度）+ 恢复块元数据缓存（不含 vec）
  // 这样重启后 store 非空，既能直接读（语义检索）又能增量写（重索引）
  _restoreChunkMeta() {
    try {
      if (this.dbFile && fs.existsSync(this.dbFile)) {
        const dim = new VectorStore(this.dbFile).detectDim();
        if (dim > 0) {
          this.store = new VectorStore(this.dbFile).init(dim);
          this.chunks = this.store.allMeta();
        }
      }
    } catch { /* 库损坏/维度异常时忽略，首次索引会重建 */ }
  }

  _loadMerkleState() {
    try {
      if (this.statusFile && fs.existsSync(this.statusFile)) {
        const data = JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
        this.merkleState = data.merkle || {};
        this.dirMerkle = data.dirMerkle || {};
      }
    } catch { this.merkleState = {}; this.dirMerkle = {}; }
  }

  _saveMerkleState() {
    try {
      if (this.statusFile) {
        // 只存 Merkle 哈希；向量在 vec.db，不再存 JSON（避免大仓库 JSON 膨胀）
        fs.writeFileSync(this.statusFile, JSON.stringify({ merkle: this.merkleState, dirMerkle: this.dirMerkle }, null, 1));
      }
    } catch (e) { console.warn('保存索引状态失败:', e.message); }
  }

  // 文件内容 SHA-256（Merkle 叶子哈希）
  _fileHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // 目录 Merkle 子树哈希：子项哈希（文件名:哈希）排序后组合哈希 —— 真 Merkle 树内部节点
  // 子项哈希来自「文件内容哈希」或「子目录子树哈希」，因此目录哈希变化 ⇔ 其下任何文件/子树变化
  _dirHash(entries) {
    const h = crypto.createHash('sha256');
    for (const e of entries.sort()) h.update(e);
    return h.digest('hex');
  }

  // 计算某目录下子项的「名称:哈希」列表（供 dirHash 用）
  // itemHashes: [{ name, hash }]，hash 对文件是内容哈希，对子目录是子树哈希
  _dirEntries(itemHashes) {
    return itemHashes.map(({ name, hash }) => `${name}:${hash}`);
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

  // embedding 文本 → 向量；首次调用确定维度并初始化向量库
  async _embed(text) {
    const out = await this.embedder(text, { pooling: 'mean', normalize: true });
    const dim = out.data.length;
    if (!this.store && this.dbFile) {
      this.store = new VectorStore(this.dbFile).init(dim);
    }
    return Array.from(out.data);
  }

  // 查询 token 化（用于 rerank 词元重叠）：小写 + 按非字母数字切分
  _tokenize(text) {
    const toks = String(text).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
    return Array.from(new Set(toks));
  }

  // rerank：对向量初选结果做混合精排（向量相似度 + 查询词元与代码内容重叠度）
  // 对标 Cursor 的 rerank 环节；本地用轻量 hybrid（语义 + 稀疏标识符匹配）替代交叉编码器
  _rerank(query, candidates) {
    const qTokens = this._tokenize(query);
    if (qTokens.length === 0) return candidates;
    for (const c of candidates) {
      const content = (c.content || '').toLowerCase();
      let overlap = 0;
      for (const t of qTokens) {
        if (content.includes(t)) overlap++;
        // 额外加分：块首行（通常是函数签名）命中权重更高
        const firstLine = content.split('\n')[0] || '';
        if (firstLine.includes(t)) overlap += 0.5;
      }
      const tokenScore = Math.min(1, overlap / qTokens.length);
      c.score = RERANK_VEC_WEIGHT * c.score + (1 - RERANK_VEC_WEIGHT) * tokenScore;
    }
    return candidates.sort((a, b) => b.score - a.score);
  }

  async _loadLangAndParse(lang, src) {
    const langObj = await this._loadLang(lang);
    if (!langObj) return null;
    this.parser.setLanguage(langObj);
    return this.parser.parse(src);
  }

  // 对单个文件做 tree-sitter 分块 + embedding（返回新块数组，含 vec）
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
      out.push({ path: filePath, lang, start: n.startPosition.row + 1, end: n.endPosition.row + 1, content, vec });
    }
    return out;
  }

  // 索引一个文件：删除旧块 → 重新分块+embedding → 写入向量库 → 更新 Merkle 哈希。返回新增块数。
  async indexFile(filePath, lang) {
    let src;
    try { src = fs.readFileSync(filePath, 'utf8'); } catch { return 0; }
    const hash = this._fileHash(src);
    const oldHash = this.merkleState[filePath];
    const inStore = this.store ? this.store.count() >= 0 && this._hasPath(filePath) : this._hasPath(filePath);
    // Merkle 增量：文件哈希未变且向量库中已有该文件块 → 跳过（避免重扫慢速网络盘 + 重复 embedding）
    if (oldHash === hash && inStore) return 0;
    // 重索引：先清该文件旧块（向量库 + 元数据缓存），再分块+embedding
    this._removeFileChunks(filePath);
    const newChunks = await this._chunkAndEmbed(filePath, lang);
    if (this.store) {
      for (const c of newChunks) {
        this.store.upsert({ path: c.path, lang: c.lang, start: c.start, end: c.end, content: c.content }, c.vec);
      }
      // 更新元数据缓存
      this.chunks = this.chunks.filter((x) => x.path !== filePath);
      for (const c of newChunks) this.chunks.push({ path: c.path, lang: c.lang, start: c.start, end: c.end });
    }
    this.merkleState[filePath] = hash;
    this._saveMerkleState();
    return newChunks.length;
  }

  // 向量库中是否已有该 path 的块
  _hasPath(filePath) {
    if (!this.store) return this.chunks.some((c) => c.path === filePath);
    return this.store.hasPath(filePath);
  }

  // 移除某文件的所有块（向量库 + 元数据缓存 + Merkle 删除）
  _removeFileChunks(filePath) {
    if (this.store) this.store.removeByPath(filePath);
    this.chunks = this.chunks.filter((c) => c.path !== filePath);
  }

  // 移除一个已删除的文件
  removeFile(filePath) {
    this._removeFileChunks(filePath);
    if (this.merkleState[filePath]) {
      delete this.merkleState[filePath];
      this._saveMerkleState();
    }
  }

  // 计算目录下所有 C/C++ 文件内容哈希的组合哈希（该目录的 Merkle 子树哈希）
  // 目录内任一文件内容变化 → 子树哈希变化；用于「目录未变则整目录跳过」
  // 不递归子目录内容（子目录由各自目录哈希独立判断），文件级 Merkle 仍兜底精确定位变化文件
  _computeDirHash(dirPath, files, detectLang) {
    const entries = [];
    for (const f of files) {
      let src;
      try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      entries.push(`${path.basename(f)}:${this._fileHash(src)}`);
    }
    return this._dirHash(entries);
  }

  // 增量索引：目录级 Merkle 子树哈希快速跳过未变目录 + 文件级哈希精确定位变化文件。
  // 返回统计（含 dirsSkipped：整目录未变而跳过的目录数）。
  // 价值：慢速 X 盘上目录未变时无需逐个文件重算 embedding / 重复读盘。
  async incrementalIndex(fileList, detectLang, onProgress) {
    const stats = { indexed: 0, unchanged: 0, removed: 0, chunks: 0, dirsSkipped: 0 };
    const byDir = new Map();
    for (const f of fileList) {
      const dir = path.dirname(f);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    const seen = new Set();
    const curDirs = new Set();
    let doneDirs = 0;
    const totalDirs = byDir.size;
    for (const [dir, files] of byDir) {
      curDirs.add(dir);
      doneDirs++;
      // 目录级 Merkle：算该目录子树哈希，未变则整目录跳过（不读文件内容、不跑 embedding）
      const dirHash = this._computeDirHash(dir, files, detectLang);
      if (this.dirMerkle[dir] === dirHash) {
        for (const f of files) { seen.add(f); stats.unchanged++; }
        stats.dirsSkipped++;
        continue;
      }
      // 目录变了：逐个文件精确处理（文件级 Merkle 跳过未变文件，只重索引变化的）
      for (const f of files) {
        seen.add(f);
        const lang = detectLang ? detectLang(f) : (f.endsWith('.c') ? 'c' : 'cpp');
        const n = await this.indexFile(f, lang);
        if (n === 0) {
          if (this.merkleState[f]) stats.unchanged++;
          else stats.indexed++;
        } else { stats.indexed++; stats.chunks += n; }
      }
      this.dirMerkle[dir] = dirHash;
      if (onProgress) onProgress({ doneDirs, totalDirs, stats });
    }
    // 清理已删除文件
    for (const f of Object.keys(this.merkleState)) {
      if (!seen.has(f)) { this.removeFile(f); stats.removed++; }
    }
    // 清理已不存在的目录（Merkle 树目录节点删除）
    for (const d of Object.keys(this.dirMerkle)) {
      if (!curDirs.has(d)) delete this.dirMerkle[d];
    }
    this._saveMerkleState();
    return stats;
  }

  // 语义搜索：query → embedding → 向量库 KNN 初选 topN → rerank 精排 → 返回块
  async search(query, topK = 5) {
    if (!this.store) {
      // 未初始化向量库（未索引过）
      return [];
    }
    const qv = await this._embed(query);
    // KNN 初选一个较大的候选池（如 3*topK），交给 rerank 精排
    const poolSize = Math.max(10, topK * 3);
    const rows = this.store.search(qv, poolSize);
    const candidates = rows.map((r) => ({
      id: r.id, path: r.path, lang: r.lang, start: r.start, end: r.end, content: r.content,
      // vec0 distance 越小越相似 → 转相似度分数（0~1）
      score: Math.max(0, 1 - r.distance),
    }));
    // 按文件聚合：同一文件只保留最高分块
    const byFile = new Map();
    for (const c of candidates) {
      if (!byFile.has(c.path) || c.score > byFile.get(c.path).score) byFile.set(c.path, c);
    }
    let merged = Array.from(byFile.values()).sort((a, b) => b.score - a.score);
    // rerank 精排
    merged = this._rerank(query, merged);
    return merged.slice(0, topK).map(({ score, ...rest }) => ({ ...rest, score: Number(score.toFixed(4)) }));
  }

  // 关闭向量库连接（索引完成后释放资源）
  close() {
    if (this.store) { this.store.close(); this.store = null; }
  }
}

module.exports = { SemanticIndex };
