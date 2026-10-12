# Codebase Index & C/C++ Jump — VS Code 扩展

> 🪟 **Windows 用户请先看 [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) 安装指南**（git clone + npm install + F5）


复刻 Cursor 核心能力的本地 VS Code 扩展，适用于 **Windows + VS Code + 代码/编译工具在 Linux 服务器（网络挂载 X 盘）** 的开发环境。

1. **C/C++ 搜索与跳转**（符号搜索 + 定义跳转）— 通过 **clangd LSP**
2. **codebase-indexing 语义检索**（自然语言搜代码）— 通过 **tree-sitter 分块 + 代码专用 embedding + 向量库 KNN 检索 + rerank**
3. **向量库存储** — sqlite-vec（本地嵌入式向量库）持久化向量，大仓库重启无需全量读回内存
4. **Merkle 增量索引** — 目录级子树哈希 + 文件级哈希，只索引变化文件，避免重扫慢速网络挂载盘
5. **全文搜索**（ripgrep）

## 架构

```
┌─────────────────────────── codebase-index 扩展 ───────────────────────────┐
│  clangd-client.js   →  clangd LSP（符号搜索 workspace/symbol + 定义跳转）    │
│  semantic-index.js  →  tree-sitter 语法分块 + jina-code(代码专用) embedding │
│                        + rerank 精排 + Merkle 增量（目录级+文件级）          │
│  vector-store.js    →  sqlite-vec 向量库（磁盘持久化 + KNN 检索）            │
└───────────────────────────────────────────────────────────────────────────┘
```

## 命令

| 命令 | 功能 | 说明 |
|---|---|---|
| `Codebase Index: 索引工作区` | Merkle 增量索引 C/C++ 文件 | 首次全量，后续只索引变化文件 |
| `Codebase Index: 语义搜索代码` | 自然语言搜代码 | jina-code 代码专用 embedding |
| `Codebase Index: 搜索符号 (C/C++)` | clangd 符号搜索 | |
| `Codebase Index: 跳转到定义 (C/C++)` | clangd 定义跳转 | |
| `Codebase Index: 全文搜索 (ripgrep)` | 全文搜索 | |

## 环境适配（Windows + X 盘网络挂载）

- **Merkle 增量索引**：目录级子树哈希（整目录未变直接跳过，不读内容不跑 embedding）+ 文件级 SHA-256（精确定位变化文件）→ 慢速网络盘只扫变化部分
- **向量库持久化**：`.codebase-index/vec.db`（sqlite-vec），向量落盘，重启秒开、不重算 embedding；`merkle-state.json` 只存哈希（不再塞全量向量）
- **rerank 精排**：向量 KNN 初选 + 查询词元与代码内容重叠度混合重排，对标 Cursor 的 rerank 环节
- **网络盘健壮性**：文件遍历逐个 try/catch，不可读目录跳过
- **路径**：用 `path` 模块处理 Windows 分隔符；语义搜索结果跨 `/` 和 `\` 取文件名

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `codebaseIndex.clangdPath` | `clangd` | clangd 可执行路径（Windows 需装 Windows 版 clangd）|
| `codebaseIndex.embeddingModel` | `jinaai/jina-embeddings-v2-base-code` | **代码专用 embedding**（768 维，中文查询需带代码上下文）|
| `codebaseIndex.embeddingProxy` | 空 | 下载 embedding 模型的 HTTP 代理（如 `http://127.0.0.1:7897`）|

> 说明：embedding 模型首次使用需从 HuggingFace 下载（约几百 MB），Windows 网络受限时配置 `embeddingProxy`。
> jina-code 是代码专用模型；若中文自然语言查询效果不佳，可回退 `Xenova/bge-m3`（通用，1024 维）。

## C/C++ 跳转（跨平台注意）

- clangd 需要与**代码所在平台**匹配。代码/编译工具在 Linux，若 X 盘是 SMB 挂载，**建议在 Linux 侧跑 clangd**（`compile_commands.json` 是 Linux 路径），Windows 侧通过 LSP 远程连接；本扩展默认在本地 spawn clangd，适合 `clangdPath` 指向可访问的 clangd。
- `compile_commands.json` 是定义跳转生效的关键（研究结论：最大落地障碍）。

## 验证（端到端实测）

- ✅ Merkle 增量：首次索引 3 文件 → 二次索引 0 变化（全部命中哈希）→ 修改后精确检测 1 个变化
- ✅ 语义检索：`jina-code` 「求两个整数之和的函数」→ `foo.cpp int add(...)`；「主程序入口」→ `main.cpp`
- ✅ C/C++：符号搜索 42 个；定义跳转 `main.cpp demo::add` → `foo.h`

## 安装

```bash
cd codebase-index-ext && npm install
# VS Code 中按 F5 打开扩展开发主机（依赖 clangd + 网络下载 embedding 模型）
```
