// 最终验证：Merkle 增量索引 + jina-code 代码专用 embedding（真实 cpp-test 项目）
const { setGlobalDispatcher, ProxyAgent } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const { SemanticIndex } = require('./src/semantic-index');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const project = '/Users/edward/Documents/New project/cursor-index-re/cpp-test';
  const srcDir = path.join(project, 'src');
  const idx = new SemanticIndex({ embeddingModel: 'jinaai/jina-embeddings-v2-base-code', workspaceRoot: project });
  console.log('初始化 jina-code（代码专用 embedding）...');
  await idx.init();
  console.log('模型已加载\n');

  // ---- 1. 首次索引 ----
  console.log('=== 1. 首次索引 cpp-test ===');
  const files = ['main.cpp','foo.cpp','foo.h'].map(f=>path.join(srcDir,f));
  for (const f of files) await idx.indexFile(f, f.endsWith('.c')?'c':'cpp');
  console.log(`  块数: ${idx.chunks.length}, Merkle 条目: ${Object.keys(idx.merkleState).length}`);

  // ---- 2. 二次索引（增量应 0 变化）----
  console.log('\n=== 2. 二次索引（Merkle 增量）===');
  let changed=0, unchanged=0;
  for (const f of files) {
    const n = await idx.indexFile(f, f.endsWith('.c')?'c':'cpp');
    if (n===0 && idx.merkleState[f]) unchanged++; else if(n>0)changed++;
  }
  console.log(`  变化: ${changed}, 未变(命中): ${unchanged} → 增量正确: ${unchanged===3}`);

  // ---- 3. 语义检索（按文件聚合）----
  console.log('\n=== 3. 语义检索（jina-code，按文件聚合）===');
  const queries = ['求两个整数之和的函数', '计算阶乘', '主程序入口'];
  for (const q of queries) {
    const r = await idx.search(q, 1);
    const fname = r[0].path.split('/').pop();
    console.log(`  「${q}」→ ${fname}:${r[0].start} (${r[0].score}) | ${r[0].content.split('\n')[0].slice(0,40)}`);
  }
  console.log('\n✅ 最终验证完成');
})().catch(e=>{console.error('错误:',e.message);process.exit(1)});
