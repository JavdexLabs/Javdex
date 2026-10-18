---
title: 源码架构与本地构建指南
description: Javdex Monorepo 工作区拓扑、11 项架构边界门禁、本地开发调试与全平台桌面端及 Docker 服务端打包命令。
---

欢迎参与 Javdex 开源项目的开发与贡献！本文档直接对应仓库根目录 `package.json`、`scripts/dist.mjs` 与 `Dockerfile`，面向开发者梳理 Monorepo 工作区职责、架构边界检查门禁、本地开发流程与打包发布命令。

---

## Monorepo 工作区拓扑与架构边界检查

Javdex 使用 `npm workspaces` 管理多包单体仓库，所有构建与检查命令统一从**仓库根目录**执行：

```text
Javdex/
├── apps/
│   ├── desktop/            # Electron 桌面客户端 (src/main 主进程 + src/preload + src/renderer + src/mcp)
│   ├── server/             # 独立 Node.js 服务端宿主与 /opt/javdex-manager 容器托管更新器
│   └── web/                # 局域网只读 Web 浏览端 (桌面端与独立服务端共用静态产物)
├── packages/
│   ├── contracts/          # 跨端共享純类型、协议 Schema 与纯函数 (browser / manage / desktop / protocol)
│   ├── library/            # 核心资料库引擎：SQLite Schema v21、扫描器、番号解析、NFO 编解码、备份恢复
│   ├── http/               # 局域网 HTTP/HTTPS 路由服务、自签名证书固定请求客户端与更新包协议
│   └── ui/                 # 桌面端与 Web 端共用的基础 UI 组件 (Checkbox 等)
├── bundled-plugins/        # 随应用捆绑分发的官方刮削插件 (video/{JavDB,JavLibrary,MetaTube}, actress/{Xslist,Gfriends})
├── website/                # Astro Starlight 官方文档站与下载中心独立工作区 (@javdex/website)
├── build/                  # 打包目标矩阵 (packaging.targets.json) 与平台图标资源
└── scripts/                # 架构门禁检查、原生模块构建、打包与冒烟测试脚本
```

### 11 项自动化架构边界门禁（`pretest`）
为确保桌面端、独立服务端与浏览器端代码严格解耦，仓库通过 `scripts/check-*.mjs` 实施了 11 项静态边界检查：
- `npm run check:workspaces`：校验工作区依赖声明一致性。
- `npm run check:library-boundaries`：确保 `packages/library` 零 Electron 依赖，可在纯 Node.js 服务端独立运行。
- `npm run check:http-boundaries` & `npm run check:http-node-load`：确保 `packages/http` 边界纯净且可在纯 Node 环境直接加载。
- `npm run check:server-boundaries` & `npm run check:server-production-closure`：确保 `apps/server` 不反向依赖桌面端模块，且生产打包闭包完整自包含。
- `npm run check:desktop-architecture`：确保渲染进程通过受控 IPC 契约通信，不越界直接操作底层数据库。
- `npm run check:actress-boundaries` / `check:media-asset-store-boundaries` / `check:metadata-source-boundaries` / `check:classification-entity-boundaries` / `check:agent-platform-boundaries`：保障各核心领域模型的封装边界。
- `npm run check:css-architecture` & `npm run check:ui-controls`：强制执行语义化 CSS Token（`--surface-*`、`--text-*`、`--control-*`）与统一组件规范。

---

## 本地开发环境准备与启动

### 1. 基础环境要求
- **Node.js**：推荐 **Node.js 22 LTS**（与服务端容器运行时 `node:22-bookworm-slim` 保持一致）。
- **C++ 原生编译工具链**（用于编译 `better-sqlite3` 及可选的本地 `libmpv` 原生插件）：
  - **Windows**：Visual Studio Build Tools（勾选“使用 C++ 的桌面开发”）+ Python 3。
  - **macOS**：Xcode Command Line Tools（`xcode-select --install`）。
  - **Linux**：`build-essential`、`python3`。

### 2. 安装依赖与初始化桌面端原生模块

```bash
# 1. 克隆仓库并安装依赖
git clone https://github.com/JavdexLabs/Javdex.git
cd Javdex
npm ci

# 2. 针对当前 Electron ABI 重新编译 better-sqlite3
npm run setup:desktop
```

### 3. 启动本地开发服务

| 开发场景 | 启动命令 | 说明 |
| :--- | :--- | :--- |
| **桌面客户端开发（含 Web 前端构建）** | `npm run dev` | 先构建局域网 Web 静态资源（`web:build`），随后启动 Electron 主进程与渲染进程 HMR 热重载。 |
| **局域网 Web 前端监听构建** | `npm run web:dev` | 使用 `vite build --config vite.web.config.ts --watch` 实时监听编译 `apps/web`。 |
| **官方文档站本地实时开发** | `npm run pages:dev` | 启动 Astro Starlight 开发服务器（热重载预览文档与下载页）。 |
| **官方文档站离线静态构建与检查** | `npm run pages:build:offline && npm run pages:check` | 生成 `dist-pages/` 静态站点并校验全部站内链接、锚点、Pagefind 索引与 Sitemap。 |

---

## 类型检查、代码规范与测试矩阵

在提交 Pull Request 前，可在根目录运行以下检查命令：

```bash
# 1. 全工作区 TypeScript 类型检查 (Node 端 + 渲染端 + 浏览器端)
npm run typecheck

# 2. ESLint (TS/TSX) 与 Stylelint (CSS Modules) 检查
npm run lint

# 3. 完整单元测试、架构门禁与 Electron 集成测试
npm test

# 4. 独立服务端与容器托管更新器专项测试
npm run server:test
npm run server:updater:test

# 5. 文档站内容契约与死链测试
npm run pages:test
```

---

## 桌面端与服务端打包构建命令

### 1. 桌面端安装包构建（`scripts/dist.mjs`）

打包目标配置定义在 `build/packaging.targets.json` 中（可通过 `npm run packaging:list` 查看当前启用的平台目标）：

```bash
# 查看当前所有打包 Target 状态
npm run packaging:list

# Windows 打包 (产出 NSIS .exe 安装包与 .zip 免安装版)
npm run dist:win

# Windows 本地编译 libmpv 播放运行库并打包
npm run dist:win:local

# macOS 打包 (产出 arm64 与 x64 .dmg 镜像)
npm run dist:mac

# Linux 打包 (产出 x86_64 .AppImage 与 amd64 .deb 软件包)
npm run dist:linux
```

### 2. 独立服务端与 Docker 容器构建

```bash
# 1. 编译 Web 前端、服务端业务闭包与容器托管更新器至 out/server
npm run server:build

# 2. 构建官方多层架构 Docker 镜像 (包含 /opt/javdex-manager 与 /app 种子)
docker build -t ghcr.io/javdexlabs/javdex-server:local .

# 3. 运行 Docker 容器端到端冒烟测试 (需本机 Docker Daemon 运行中)
npm run server:smoke
```
