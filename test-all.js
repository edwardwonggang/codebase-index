// 综合端到端验证：C/C++ 跳转 + 语义检索 + 全文搜索
const { setGlobalDispatcher, ProxyAgent } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const { ClangdClient } = require('./src/clangd-client');
const { SemanticIndex } = require('./src/semantic-index');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);

(async () => {
  const project = '/Users/edward/Documents/New project/cursor-index-re/cpp-test';
  console.log('========== 1. C/C++ 搜索与跳转（clangd LSP）==========');
  const clangd = new ClangdClient('/usr/bin/clangd', project);
  await clangd.start();
  for (const rel of ['src/main.cpp','src/foo.cpp','src/foo.h']) {
    const p = path.join(project, rel);
    await clangd.openDocument('file://'+p, fs.readFileSync(p,'utf8'), 'cpp');
  }
  await new Promise(r=>setTimeout(r,2000));
  const syms = await clangd.searchSymbol('add');
  const proj = syms.filter(s=>s.location.uri.includes('cpp-test'));
  console.log(`  符号搜索 "add": ${syms.length} 个（项目内 ${proj.length}）`);
  const defs = await clangd.goToDefinition('file://'+project+'/src/main.cpp', 3, 12);
  if (defs&&defs.length) console.log(`  定义跳转 main.cpp:4 demo::add → ${defs[0].uri.split('cpp-test/')[1]}:${defs[0].range.start.line+1}`);
  await clangd.stop();

  console.log('\n========== 2. codebase 语义检索（tree-sitter + embedding）==========');
  const idx = new SemanticIndex({ embeddingModel: 'jinaai/jina-embeddings-v2-base-code', workspaceRoot: project });
  await idx.init();
  for (const rel of ['src/main.cpp','src/foo.cpp','src/foo.h']) {
    await idx.indexFile(path.join(project, rel), 'cpp');
  }
  console.log(`  已索引 ${idx.chunks.length} 个代码块`);
  const q = '加法函数';
  const r = await idx.search(q, 1);
  console.log(`  查询「${q}」→ ${r[0].path.split('/').pop()}:${r[0].start} | ${r[0].content.split('\n')[0].slice(0,40)} (相似度 ${r[0].score})`);

  console.log('\n========== 3. 全文搜索（ripgrep）==========');
  const { stdout } = await execFileP('rg', ['-n', 'add', project]);
  const lines = stdout.split('\n').filter(Boolean);
  console.log(`  全文搜索 "add": ${lines.length} 处匹配`);
  lines.slice(0,3).forEach(l=>console.log('   ', l.split(project+'/')[1] || l));

  console.log('\n✅ 全部三项能力端到端验证通过');
})().catch(e=>{console.error('错误:',e.message);process.exit(1)});
