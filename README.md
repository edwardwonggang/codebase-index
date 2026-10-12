# Codebase Index & C/C++ Jump — VS Code 扩展

复刻 Cursor 核心能力的本地 VS Code 扩展，适用于 **Windows + VS Code + 代码/编译工具在 Linux 服务器（网络挂载 X 盘）** 的开发环境。

1. **C/C++ 搜索与跳转**（符号搜索 + 定义跳转）— 通过 **clangd LSP**
2. **codebase-indexing 语义检索**（自然语言搜代码）— 通过 **tree-sitter 分块 + 代码专用 embedding + 向量检索**
3. **Merkle 增量索引** — 只索引变化文件，避免重扫慢速网络挂载盘
4. **全文搜索**（ripgrep）

## 架构

```
┌─────────────────────────── codebase-index 扩展 ───────────────────────────┐
│  clangd-client.js   →  clangd LSP（符号搜索 workspace/symbol + 定义跳转）    │
│  semantic-index.js  →  tree-sitter 语法分块 + jina-code(代码专用) embedding │
│                        + 余弦 KNN 检索 + Merkle 增量索引(SHA-256)           │
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

- **Merkle 增量索引**：每个文件算 SHA-256，哈希未变不重新 embedding → 慢速网络盘只扫一次文件列表，不重复读内容
- **索引状态持久化**：`.codebase-index/merkle-state.json`（工作区内，重启不丢）
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
