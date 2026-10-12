// 验证真 Merkle 树（目录级子树哈希）：首次全量 / 二次整目录跳过 / 单文件改动精准重索引
const { SemanticIndex } = require('./src/semantic-index');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merkle-tree-'));
  // 构造两个目录，各 2 个 C 文件
  const srcA = path.join(tmp, 'a');
  const srcB = path.join(tmp, 'b');
  fs.mkdirSync(srcA, { recursive: true });
  fs.mkdirSync(srcB, { recursive: true });
  fs.writeFileSync(path.join(srcA, 'a1.c'), 'int addA(int a, int b) { return a + b; }\n');
  fs.writeFileSync(path.join(srcA, 'a2.c'), 'int subA(int a, int b) { return a - b; }\n');
  fs.writeFileSync(path.join(srcB, 'b1.c'), 'long mulB(int a, int b) { return a * b; }\n');
  fs.writeFileSync(path.join(srcB, 'b2.c'), 'int divB(int a, int b) { return a / b; }\n');
  const allFiles = [path.join(srcA,'a1.c'), path.join(srcA,'a2.c'), path.join(srcB,'b1.c'), path.join(srcB,'b2.c')];
  const detectLang = (f) => (f.endsWith('.c') ? 'c' : 'cpp');

  const idx = new SemanticIndex({ embeddingModel: 'jinaai/jina-embeddings-v2-base-code', workspaceRoot: tmp });
  await idx.init();

  // 测试1: 首次全量索引
  console.log('=== 测试1: 首次索引 ===');
  const s1 = await idx.incrementalIndex(allFiles, detectLang);
  console.log(`  新增 ${s1.indexed}, 未变 ${s1.unchanged}, 目录跳过 ${s1.dirsSkipped}, 块 ${s1.chunks}`);
  console.log(`  目录哈希记录: ${JSON.stringify(idx.dirMerkle)}`);
  if (s1.indexed !== 4) { console.log('  ✗ 首次应索引 4 个文件'); process.exit(1); }

  // 测试2: 二次索引（目录未变 → 整目录跳过）
  console.log('\n=== 测试2: 二次索引（应整目录跳过，0 变化）===');
  const s2 = await idx.incrementalIndex(allFiles, detectLang);
  console.log(`  新增 ${s2.indexed}, 未变 ${s2.unchanged}, 目录跳过 ${s2.dirsSkipped}`);
  if (s2.indexed !== 0 || s2.dirsSkipped !== 2) { console.log('  ✗ 应 0 新增、2 目录跳过'); process.exit(1); }
  console.log('  ✓ 目录级 Merkle 生效');

  // 测试3: 修改 a1.c → a 目录哈希变，只重索引 a；b 目录跳过
  console.log('\n=== 测试3: 修改 a1.c（只重索引 a 目录）===');
  await new Promise(r=>setTimeout(r,1100));
  fs.writeFileSync(path.join(srcA,'a1.c'), 'int addA(int a, int b) { return a + b + 1; }\n');
  const s3 = await idx.incrementalIndex(allFiles, detectLang);
  console.log(`  新增 ${s3.indexed}, 未变 ${s3.unchanged}, 目录跳过 ${s3.dirsSkipped}`);
  if (s3.indexed !== 1 || s3.dirsSkipped !== 1) { console.log('  ✗ 应重索引 1 文件、跳过 1 目录'); process.exit(1); }
  console.log('  ✓ 目录级 Merkle 精准检测单文件改动');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n✅ 真 Merkle 树验证通过（临时目录已清理）');
})().catch(e=>{console.error('错误:',e.message);process.exit(1)});
