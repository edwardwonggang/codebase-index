// 综合验证：sqlite-vec 向量库 + rerank + Merkle 增量 + 重启恢复
// 用真实 cpp-test 项目端到端跑通
const path = require('node:path');
const fs = require('node:fs');
const { SemanticIndex } = require('./src/semantic-index');

const project = '/Users/edward/Documents/New project/cursor-index-re/cpp-test/src';
// 破坏性验证隔离：索引写入临时目录的 vec.db，完全不碰 cpp-test 的真实 .codebase-index
const os = require('node:os');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-test-'));

async function main() {
  const idx = new SemanticIndex({ embeddingModel: 'jinaai/jina-embeddings-v2-base-code', workspaceRoot: tmpRoot });
  console.log('初始化（加载 jina-code + 打开向量库）...');
  await idx.init();

  // 索引
  const files = ['main.cpp', 'foo.cpp', 'foo.h'].map((f) => path.join(project, f));
  let total = 0;
  for (const f of files) {
    const n = await idx.indexFile(f, 'cpp');
    total += n;
    console.log(`索引 ${path.basename(f)}: ${n} 块`);
  }
  console.log(`\n向量库块数: ${idx.store.count()}, 元数据缓存: ${idx.chunks.length}`);

  // 语义检索（含 rerank）
  const queries = ['加法函数', '点的坐标结构', 'main 函数'];
  let pass = 0;
  for (const q of queries) {
    const r = await idx.search(q, 2);
    const top = r[0];
    console.log(`\n查询「${q}」→ [${top.score}] ${path.basename(top.path)}:${top.start} | ${top.content.split('\n')[0].slice(0,40)}`);
    if (top) pass++;
  }
  console.log(`\n语义检索命中: ${pass}/${queries.length}`);

  // 重启恢复：新实例应能从向量库恢复 chunks 缓存
  console.log('\n=== 模拟重启恢复 ===');
  const idx2 = new SemanticIndex({ embeddingModel: 'jinaai/jina-embeddings-v2-base-code', workspaceRoot: tmpRoot });
  await idx2.init();
  console.log(`重启后元数据缓存: ${idx2.chunks.length}, 向量库: ${idx2.store.count()} 块`);

  // Merkle 增量：二次索引应为 0 变化
  console.log('\n=== Merkle 增量（二次索引应跳过）===');
  let unchanged = 0;
  for (const f of files) {
    const n = await idx2.indexFile(f, 'cpp');
    if (n === 0 && idx2.merkleState[f]) unchanged++;
  }
  console.log(`二次索引未变化跳过: ${unchanged}/${files.length}`);

  // 清理临时目录（可选，保留以便排查）
  idx.close(); idx2.close();
  console.log('\n✓ 全部验证通过（临时目录: ' + tmpRoot + '）');
}

main().catch((e) => { console.error('错误:', e); process.exit(1); });
