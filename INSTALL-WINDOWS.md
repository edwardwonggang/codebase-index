# Windows 安装指南（VS Code 扩展）

本扩展的运行时依赖（onnxruntime 等）是**平台相关**的，必须在你自己的 Windows 机器上
`npm install` 安装对应平台版本，因此**不提供跨平台 .vsix**，采用「克隆源码 + npm install + 运行」方式。

## 一、环境要求（Windows 机器上）

1. **VS Code**（≥ 1.85）
2. **Node.js**（≥ 18，建议 20/22）— 从 https://nodejs.org 下载安装
3. **clangd**（C/C++ 搜索跳转用）— 见下方说明
4. **git**（可选，用于克隆；也可直接下载 zip）

## 二、安装步骤

### 1. 获取代码
```bash
# 方式A：git 克隆
git clone https://github.com/edwardwonggang/codebase-index.git
cd codebase-index

# 方式B：直接下载 zip（GitHub 页面 Code → Download ZIP，解压到某目录）
```

### 2. 安装依赖
```bash
npm install
```
> ⚠️ 如果下载慢/失败，先配置 npm 镜像：
> ```bash
> npm config set registry https://registry.npmmirror.com
> ```

> ⚠️ **`better-sqlite3` 是原生模块，prebuild 默认从 GitHub 下载**。公司电脑无法访问国外时，
> 在 `npm install` 前先指向国内 prebuild 镜像（npmmirror 已镜像 better-sqlite3 prebuild）：
> ```bash
> # Windows cmd（设置环境变量后 install）
> set npm_config_better_sqlite3_binary_host=https://npmmirror.com/mirrors/better-sqlite3/
> npm install
>
> # PowerShell 写法
> $env:npm_config_better_sqlite3_binary_host="https://npmmirror.com/mirrors/better-sqlite3/"
> npm install
> ```
> 若仍失败，可退而求其次本地编译：`npm install better-sqlite3 --build-from-source`（需 VS Build Tools）。
> `sqlite-vec` 的预编译二进制本身是 npm 包，走 npmmirror 镜像即可获得（Windows x64 为 .dll），无需额外配置。

### 3. 运行扩展
- 用 VS Code 打开 `codebase-index` 文件夹
- 按 `F5`（或运行 → 启动调试），会打开「扩展开发主机」窗口
- 在新窗口命令面板（`Ctrl+Shift+P`）运行：
  - `Codebase Index: 索引工作区`
  - `Codebase Index: 语义搜索代码`
  - `Codebase Index: 搜索符号 (C/C++)`
  - `Codebase Index: 跳转到定义 (C/C++)`
  - `Codebase Index: 全文搜索 (ripgrep)`

## 三、配置（.vscode 或 settings.json）

在 VS Code 设置（`Ctrl+,`）搜索 `codebaseIndex` 配置：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `codebaseIndex.clangdPath` | `clangd` | clangd 可执行文件路径 |
| `codebaseIndex.embeddingModel` | `jinaai/jina-embeddings-v2-base-code` | 代码专用 embedding（首次需下载几百 MB）|
| `codebaseIndex.embeddingProxy` | 空 | 下载 embedding 模型的 HTTP 代理（如 `http://127.0.0.1:7897`）|

## 四、你的特殊环境（代码/编译工具在 Linux，X 盘挂载）

### C/C++ 搜索跳转（clangd 跨平台）
代码和 `compile_commands.json` 在 Linux 服务器。**clangd 必须能读到编译数据库**。两种做法：

- **推荐：在 Linux 侧跑 clangd + LSP 远程**
  用 VS Code 的 **Remote-SSH** 插件直接连到 Linux 服务器，扩展在远端运行，clangd 读本机
  `compile_commands.json`，路径一致、跳转准确。这是最省事的方案。
- 或：Windows 装 clangd（winget install LLVM.LLVM 或 https://clangd.llvm.org/），把
  `codebaseIndex.clangdPath` 指向它。但 SMB 挂载的 X 盘路径与 Linux 路径不一致时，跳转可能失效。

### 语义检索（codebase-indexing）
- 语义检索不依赖 clangd/编译数据库，直接对 X 盘上的 C/C++ 文件做 tree-sitter 分块 + embedding，
  **在 Windows 上即可用**，与 Linux 无关。
- Merkle 增量索引只扫变化文件，**避免反复读慢速 X 盘**，适合网络挂载环境。
- embedding 模型首次下载较慢，若网络受限配置 `codebaseIndex.embeddingProxy`。

## 五、常见问题

| 问题 | 解决 |
|---|---|
| `npm install` 卡住/失败 | 用 npmmirror 镜像（见上）|
| embedding 模型下载失败 | 配置 `codebaseIndex.embeddingProxy` 走代理 |
| clangd 报 method not found | 确认 clangd 版本 ≥ 15，且 `clangdPath` 正确 |
| 定义跳转不生效 | 检查项目根目录是否有 `compile_commands.json`（或 clangd 用 fallbackFlags）|
| 语义搜索提示先索引 | 先运行 `Codebase Index: 索引工作区` |

## 六、项目结构
```
codebase-index/
├── src/
│   ├── extension.js        # 扩展入口（5 个命令）
│   ├── clangd-client.js    # C/C++ 搜索跳转（clangd LSP）
│   ├── semantic-index.js   # 语义检索 + rerank + Merkle 增量（目录级+文件级）
│   └── vector-store.js     # sqlite-vec 向量库（磁盘持久化 + KNN）
├── test-v2.js              # Merkle 增量 + jina-code 验证
├── test-vector.js          # 向量库 + rerank + 重启恢复验证
├── test-merkle-tree.js     # 目录级真 Merkle 树验证
├── test-final.js           # 真实项目最终验证
└── test-semantic.js        # 语义精度专项验证
```
