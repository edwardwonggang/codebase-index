// 端到端验证 semantic-index：tree-sitter 分块 + embedding + 语义检索
// 走代理下载 embedding 模型
const { setGlobalDispatcher, ProxyAgent } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));

const { SemanticIndex } = require('./src/semantic-index');
const path = require('node:path');

(async () => {
  const project = '/Users/edward/Documents/New project/cursor-index-re/cpp-test/src';
  const idx = new SemanticIndex({ embeddingModel: 'jinaai/jina-embeddings-v2-base-code', workspaceRoot: project });
  console.log('初始化语义索引（加载 embedding 模型）...');
  await idx.init();
  console.log('模型已加载\n');

  // 索引 cpp-test 的 C++ 文件
  const files = ['main.cpp', 'foo.cpp', 'foo.h'];
  for (const f of files) {
    const n = await idx.indexFile(path.join(project, f), 'cpp');
    console.log(`索引 ${f}: ${n} 个代码块`);
  }
  console.log(`\n共 ${idx.chunks.length} 个代码块`);

  // 语义搜索测试
  const queries = ['加法函数', '点的坐标结构', 'main 函数'];
  for (const q of queries) {
    const results = await idx.search(q, 2);
    console.log(`\n查询「${q}」→`);
    results.forEach(r => {
      const fname = r.path.split('/').pop();
      console.log(`  [${r.score}] ${fname}:${r.start} | ${r.content.split('\n')[0].slice(0,50)}`);
    });
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
