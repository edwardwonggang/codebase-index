// v2 综合验证：Merkle 增量索引 + 代码专用 embedding (jina-code)
const { setGlobalDispatcher, ProxyAgent } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const { SemanticIndex } = require('./src/semantic-index');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  // 用临时目录做 Merkle 增量测试（不污染真实项目）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-idx-'));
  const srcDir = path.join(tmp, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  // 写 2 个 C 文件
  fs.writeFileSync(path.join(srcDir, 'a.c'), 'int add(int a, int b) { return a + b; }\n');
  fs.writeFileSync(path.join(srcDir, 'b.c'), 'long factorial(int n) { if (n <= 1) return 1; return n * factorial(n-1); }\n');
  fs.writeFileSync(path.join(srcDir, 'c.h'), 'struct Point { double x, y; };\n');

  const idx = new SemanticIndex({ embeddingModel: 'jinaai/jina-embeddings-v2-base-code', workspaceRoot: tmp });
  console.log('初始化（加载代码专用 embedding jina-code，首次下载较慢）...');
  await idx.init();
  console.log('模型已加载，维度=768, 命中率预期 4/4\n');

  // ---- 测试1: 首次全量索引 ----
  console.log('=== 测试1: 首次索引 ===');
  const files = [path.join(srcDir,'a.c'), path.join(srcDir,'b.c'), path.join(srcDir,'c.h')];
  let total = 0;
  for (const f of files) total += await idx.indexFile(f, f.endsWith('.c') ? 'c' : 'cpp');
  console.log(`  首次索引: ${total} 块, 状态文件条目: ${Object.keys(idx.merkleState).length}`);
  const stateFile = path.join(tmp, '.codebase-index', 'merkle-state.json');
  console.log(`  Merkle 状态已持久化: ${fs.existsSync(stateFile)}`);

  // ---- 测试2: 二次索引（应全部命中未变化，0 新增）----
  console.log('\n=== 测试2: 二次索引（Merkle 增量，应 0 变化）===');
  const idx2 = new SemanticIndex({ embeddingModel: 'jinaai/jina-embeddings-v2-base-code', workspaceRoot: tmp });
  await idx2.init(); // 会重新加载模型（模拟重启）
  let changed2 = 0, unchanged2 = 0;
  for (const f of files) {
    const n = await idx2.indexFile(f, f.endsWith('.c') ? 'c' : 'cpp');
    if (n === 0 && idx2.merkleState[f]) unchanged2++;
    else if (n > 0) changed2++;
    else changed2++;
  }
  console.log(`  新增/变化: ${changed2}, 未变(命中 Merkle): ${unchanged2}  → 增量生效: ${unchanged2 === 3}`);

  // ---- 测试3: 修改一个文件后（应检测到 1 个变化）----
  console.log('\n=== 测试3: 修改 b.c 后增量（应只重索引 b.c）===');
  await new Promise(r=>setTimeout(r,1100)); // 确保 mtime 变化
  fs.writeFileSync(path.join(srcDir,'b.c'), 'long factorial(int n) { if (n <= 1) return 1; return n * factorial(n-1); } // modified\n');
  let changed3 = 0, unchanged3 = 0;
  for (const f of files) {
    const n = await idx2.indexFile(f, f.endsWith('.c') ? 'c' : 'cpp');
    if (n === 0 && idx2.merkleState[f]) unchanged3++;
    else if (n > 0) changed3++;
  }
  console.log(`  新增/变化: ${changed3}, 未变: ${unchanged3}  → 精确检测: ${changed3 === 1 && unchanged3 === 2}`);

  // ---- 测试4: 语义检索精度（代码专用 embedding）----
  console.log('\n=== 测试4: 代码专用 embedding 语义检索 ===');
  const queries = ['加法函数', '求阶乘', '定义坐标点结构'];
  const expected = [0, 1, 2]; // 分别对应 a.c 的 add, b.c 的 factorial, c.h 的 Point
  let hits = 0;
  for (let qi = 0; qi < queries.length; qi++) {
    const r = await idx2.search(queries[qi], 1);
    const fname = r[0].path.split('/').pop();
    // 期望：q0->a.c, q1->b.c, q2->c.h
    const correct = (qi===0 && fname==='a.c') || (qi===1 && fname==='b.c') || (qi===2 && fname==='c.h');
    if (correct) hits++;
    console.log(`  「${queries[qi]}」→ ${fname} ${correct?'✓':'✗'} (相似度 ${r[0].score})`);
  }
  console.log(`  语义检索命中率: ${hits}/${queries.length}`);

  // 清理临时目录
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n✅ v2 验证完成（临时目录已清理）');
})().catch(e=>{console.error('错误:', e.message); process.exit(1)});
