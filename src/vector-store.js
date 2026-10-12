// vector-store.js — 本地向量数据库（sqlite-vec 封装）
// 职责：用 sqlite-vec（vec0 虚拟表）+ better-sqlite3 做代码块向量的磁盘持久化与 KNN 检索。
//       替代原先「JSON 文件存全量向量」的做法，解决大仓库重启全量读回内存、内存/加载膨胀的问题。
// 调用方：semantic-index.js（indexFile 写入 / search 检索 / removeFile 删除）
// 依赖：better-sqlite3（sqlite 绑定）、sqlite-vec（向量索引扩展，跨平台预编译）
// 红线：
//   - vec0 虚拟表只接受整数 rowid，且不支持 update —— 绑定必须用 BigInt，更新需先 delete 再 insert。
//   - vec0 的向量维度在建表时固定；embedding 模型维度变化（如 jina-code 768 / bge-m3 1024）时须重建表。
//   - rowid 用 chunks.id（自增主键），同一 path 的旧块通过 delete 清掉，避免重复块累积。
const path = require('node:path');
const fs = require('node:fs');

class VectorStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.dim = 0;
  }

  // 打开/初始化数据库：加载 sqlite-vec，建 chunks 元数据表 + vec0 向量表
  init(dim) {
    if (!this.db) {
      const Database = require('better-sqlite3');
      const sqliteVec = require('sqlite-vec');
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true });
      this.db = new Database(this.dbPath);
      sqliteVec.load(this.db);
      this.db.pragma('journal_mode = WAL'); // WAL：写入不阻塞读取，重启恢复更快
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL,
          lang TEXT,
          start_line INTEGER,
          end_line INTEGER,
          content TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      `);
    }
    this.dim = dim;
    this._ensureVecTable(dim);
    return this;
  }

  // 确保 vec0 表存在且维度匹配；维度变化则重建（丢弃旧向量，需重新索引）
  _ensureVecTable(dim) {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_items'").get();
    if (row && row.sql.includes(`float[${dim}]`)) return;
    // 表不存在或维度不一致 → 重建
    this.db.exec(`DROP TABLE IF EXISTS vec_items`);
    this.db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[${dim}])`);
  }

  // 写入/更新一个代码块：先删该 id 旧向量再插，返回自增 id
  upsert(meta, vector) {
    const { path: p, lang, start, end, content } = meta;
    const res = this.db.prepare(
      'INSERT INTO chunks (path, lang, start_line, end_line, content) VALUES (?, ?, ?, ?, ?)'
    ).run(p, lang, start, end, content);
    const id = BigInt(res.lastInsertRowid); // better-sqlite3 返回 number，vec0 需要 BigInt
    // vec0 的 rowid 必须 BigInt 绑定；向量用 JSON 数组字符串
    this.db.prepare('INSERT INTO vec_items (rowid, embedding) VALUES (?, ?)').run(id, JSON.stringify(Array.from(vector)));
    return Number(id);
  }

  // 删除某 id 的向量与元数据
  remove(id) {
    this.db.prepare('DELETE FROM vec_items WHERE rowid = ?').run(BigInt(id));
    this.db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
  }

  // 删除某 path 的所有块（Merkle 删除路径：文件被删/重索引时先清旧块）
  removeByPath(filePath) {
    const rows = this.db.prepare('SELECT id FROM chunks WHERE path = ?').all(filePath);
    const delVec = this.db.prepare('DELETE FROM vec_items WHERE rowid = ?');
    const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?');
    for (const r of rows) {
      delVec.run(BigInt(r.id));
      delChunk.run(r.id);
    }
    return rows.length;
  }

  // KNN 检索：query 向量 → vec0 最近邻 → join chunks 拿元数据
  search(vector, topK) {
    const q = JSON.stringify(Array.from(vector));
    // 注意：vec0 的 KNN 查询必须能在 prepare 阶段识别 LIMIT，因此 topK 用整数字面量拼接
    //（topK 为内部传入的整数，非用户输入，无注入风险）
    const k = Math.max(1, Math.floor(topK));
    // vec0 的 KNN 必须放在子查询里并带可被 prepare 识别的字面量 LIMIT（topK 为内部整数，无注入风险）；
    // 主查询再 JOIN chunks 取元数据，避免 vec0 多表 JOIN 的 LIMIT 识别问题。
    const rows = this.db.prepare(`
      SELECT c.id, v.distance, c.path, c.lang, c.start_line, c.end_line, c.content
      FROM (SELECT rowid, distance FROM vec_items WHERE embedding match ? ORDER BY distance LIMIT ${k}) v
      JOIN chunks c ON c.id = v.rowid
    `).all(q);
    return rows.map((r) => ({
      id: Number(r.id),
      path: r.path,
      lang: r.lang,
      start: r.start_line,
      end: r.end_line,
      content: r.content,
      distance: r.distance,
    }));
  }

  // 统计当前向量/块数量
  count() {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get();
    return r.c;
  }

  // 列出所有已索引的 path（用于 Merkle 删除清理）
  allPaths() {
    return this.db.prepare('SELECT DISTINCT path FROM chunks').all().map((r) => r.path);
  }

  // 向量库中是否已有该 path 的块（增量索引跳过判定用）
  hasPath(filePath) {
    const r = this.db.prepare('SELECT 1 AS x FROM chunks WHERE path = ? LIMIT 1').get(filePath);
    return !!r;
  }

  // 返回所有块元数据（不含 vec），用于重启后恢复 chunks 缓存 / 进度显示
  allMeta() {
    return this.db.prepare('SELECT id, path, lang, start_line AS start, end_line AS end FROM chunks').all();
  }

  // 只读打开（不建 vec 表、不加载 sqlite-vec）：用于恢复元数据缓存
  _openReadOnly() {
    if (this.db) return;
    const Database = require('better-sqlite3');
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath, { readonly: true });
  }

  // 从已存在的 vec_items 表探测向量维度（重启恢复时用，避免重新 embedding 才知道维度）
  // 返回维度数字；库不存在或无 vec 表返回 0
  detectDim() {
    try {
      if (!fs.existsSync(this.dbPath)) return 0;
      const Database = require('better-sqlite3');
      const db = new Database(this.dbPath, { readonly: true });
      try {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_items'").get();
        if (!row) return 0;
        const m = /float\[(\d+)\]/.exec(row.sql);
        return m ? parseInt(m[1], 10) : 0;
      } finally { db.close(); }
    } catch { return 0; }
  }

  // 清空整个索引（重建索引 / 维度变化时用）
  clear() {
    this.db.exec('DELETE FROM chunks; DELETE FROM vec_items;');
  }

  close() {
    if (this.db) { try { this.db.close(); } catch {} this.db = null; }
  }
}

module.exports = { VectorStore };
