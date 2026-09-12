# Javdex 开发指南

[返回产品介绍](../README.md) · [使用指南](USER_GUIDE.md) · [版本与发布](VERSIONING_AND_RELEASE.md)

本文面向从源码运行、修改或打包 Javdex 的开发者。安装和日常操作见使用指南。

## 环境与本地启动

使用 Node.js 22、npm，以及 Windows、macOS 或 Linux。CI 使用 Node.js 22；依赖版本以仓库锁文件为准。

```bash
git clone https://github.com/JavdexLabs/Javdex.git
cd Javdex
npm ci
npm run setup:desktop
npm run dev
```

`npm ci` 安装锁定的 workspace 依赖，根安装不再自动触发 Electron rebuild。桌面开发/测试随后显式运行 `npm run setup:desktop`；如原生模块构建失败，按日志补齐开发环境后重试。服务端以后使用独立的生产依赖安装，不运行该桌面准备命令。

开发启动使用应用的用户数据目录，测试隔离机制见 [appIdentity.ts](../packages/contracts/src/appIdentity.ts) 与相关测试。调试数据库、扫描或删除行为前，使用测试资料与独立测试目录。

## 未发布数据库迁移

生产版 v0.6.2 使用 schema 15。本分支此前拆分的开发迁移 16/17/18 已合并为单次 **15 → 16**：建立 Agent 资源清理队列、升级标签覆盖索引、建立逐项扫描审计表及约束。三部分在同一事务内执行，全部成功后才记录版本 16；失败整次回滚。新建数据库与生产版升级后的结构相同。

已运行旧开发分支的数据库不属于已发布升级路径。旧不完整 schema 16 与开发 schema 17/18 会明确拒绝打开，保持数据和版本不变；使用匹配的开发构建或升级前备份处理，不要手动降低 `user_version`。合并迁移不会替用户改写已有开发数据库。将来正式增加版本 17/18 时，须重新检查旧开发库的结构识别，不能仅靠版本数字接受这些历史快照。

旧性能报告和原始证据中的 V17/V18 编号保留为当时的历史记录；当前迁移以 `packages/library/src/db/migrations.ts` 为准。回归测试使用从官方 v0.6.2 冻结的 schema SQL，验证数据保留、DDL 一致性及各阶段失败回滚。

## 检查与构建

```bash
npm run typecheck       # 主进程与渲染端类型检查
npm run lint            # TypeScript 与 CSS 检查
npm run check:encoding  # 检查可疑编码字符
npm test                # 完整检查与测试
npm run build           # 生产构建与运行时资源校验
npm start               # 预览生产构建
```

`npm test` 会先运行架构边界、lint、CSS 架构和 UI 控件检查，再执行类型检查、打包运行时测试及 Electron 测试。测试具体入口见 [package.json](../package.json)。

需要运行特定 Electron 测试文件时：

```bash
node scripts/run-electron-tests.mjs apps/desktop/src/main/nfo/nfoArtifactCodec.test.ts
```

`npm run build` 生成 `out/`，并校验人脸检测资源与 Pi 运行时。生产构建通过不等于各平台安装包已完成验证。

## 打包与发布

```bash
npm run packaging:list       # 查看启用目标和构建平台
npm run packaging:configure  # 交互选择目标
npm run dist                 # 构建配置中全部启用的目标
npm run dist:win             # Windows 目标
npm run dist:mac             # macOS 目标
npm run dist:linux           # Linux 目标
```

目标开关和架构位于 [packaging.targets.json](../build/packaging.targets.json)，基础构建配置位于 [electron-builder.config.mjs](../electron-builder.config.mjs)。本地通常选择对应平台命令；不带平台参数的 `npm run dist` 会尝试全部启用目标，不会自动筛选当前操作系统。请在目标要求的平台构建，指定 `dist:mac` 等命令不会提供跨平台编译环境。安装包输出到 `dist/`。

版本号、标签、数据库升级说明、Release 工作流和发布验证统一遵循 [版本与发布规范](VERSIONING_AND_RELEASE.md)。

## 官网开发

官网源码位于 `website/`，图片使用 `docs/images/` 中的资源。

```bash
npm run pages:build          # 读取最新正式 Release，生成下载信息
npm run pages:preview        # 构建并本地预览
npm run pages:build:offline  # 离线构建，用于本地检查页面
```

生成目录为 `dist-pages/`。离线构建不代表线上最新下载信息已经验证。

自动部署条件见 [Pages 工作流](../.github/workflows/pages.yml)：包括 `main` 上指定官网相关路径的变更、正式 Release 发布及成功结束的 Release 工作流。部署使用默认分支内容。

README 介绍产品与首次使用，官网承接展示和下载；两者复用图片时，应说明演示数据与截图版本，避免将旧截图标成当前界面。

## 代码结构与实现边界

Javdex 使用 Electron、React、TypeScript、Vite 和 `better-sqlite3`。主要目录如下：

| 目录 | 职责 |
|---|---|
| `apps/desktop/src/main` | 扫描、刮削、图片资产、AI 工作流与应用生命周期；本地装配仍打开资料库连接 |
| `apps/desktop/src/preload` | 通过 `contextBridge` 暴露受控 IPC API |
| `apps/desktop/src/renderer` | React 页面、组件、交互与查询状态 |
| `packages/contracts/src` | 跨进程类型和 IPC 通道 |
| `apps/desktop/src/mcp` | 插件开发 MCP 服务 |
| `apps/web/src` | 独立构建的只读浏览页面 |
| `packages/library/src` | Node 路径/资源身份工具、资料库数据库、图片存储、扫描辅助、NFO、维护闸门与路径清理；扫描编排、Electron 封面导出和业务服务仍在抽离 |
| `packages/ui/src` | 桌面和网页真实共用的纯展示组件 |
| `apps/server`、`packages/http` | 预留工作区，目前没有可运行服务端或已抽离 HTTP |

根通过 npm workspaces 管理内部包，统一版本；运行 `npm run check:workspaces` 检查边界。可以用 `npm run build -w @javdex/web` 单独构建网页，或 `npm run build -w @javdex/desktop` 构建桌面及附带网页。根仍暂时持有桌面打包 metadata 与生产依赖，产物目录维持 `out/`；服务端独立依赖闭包按 [执行计划](SERVER_MODE_EXECUTION_PLAN.md) 后续建立。调整产品版本时必须同时更新所有 workspace 的版本、内部依赖版本和 lockfile。

渲染进程不直接访问 Node.js、数据库或文件系统，相关操作通过主进程处理。图片通过应用的 `media://` 协议读取，主进程负责资产路径解析和解密。

插件在 Worker 沙箱中执行，通过受控 `ctx` API 访问宿主能力。内置插件开发助手支持页面探测、生成代码、试运行与验证，也可通过可选 MCP 服务接入外部工具。插件产物规范与助手实现分别查阅下表中的文档。

## 按任务查阅文档

先阅读根目录 [AGENTS.md](../AGENTS.md) 的仓库约定，再按实际改动选择文档，无需通读全部设计与研究资料。

| 工作区域 | 文档 |
|---|---|
| 领域术语与数据归属 | [领域上下文](../CONTEXT.md)、[多媒体库设计](MULTI_LIBRARY_DESIGN.md) |
| UI、样式和交互 | [UI 设计规范](UI_DESIGN_GUIDELINES.md)、[组件契约](UI_COMPONENT_CONTRACTS.md) |
| 局域网 Web 移动端 | [移动端 Web 规范](MOBILE_WEB_GUIDELINES.md) |
| 服务端模式可行性（未实施） | [服务端模式研究](SERVER_MODE_FEASIBILITY_RESEARCH.md) |
| 服务端模式执行交接 | [阶段计划与验收门槛](SERVER_MODE_EXECUTION_PLAN.md)、[管理合同与验收](SERVER_MODE_API_RESEARCH.md) |
| 路由、筛选、返回栈 | [路由设计](ROUTING_DESIGN.md) |
| 刮削插件与沙箱 API | [刮削插件规范](SCRAPER_PLUGIN_FORMAT.md) |
| 插件开发助手与 MCP | [插件开发 Agent](PLUGIN_DEV_AGENT.md) |
| NFO 导出格式与验证范围 | [NFO 兼容性](NFO_COMPATIBILITY.md) |
| 大媒体库性能与优化计划 | [性能审计](performance/large-library-performance-audit.md)、[实施计划](performance/large-library-optimization-plan.md)、[基准复跑](performance/large-library-results/README.md) |
| 数据库结构与迁移 | [schema.ts](../packages/library/src/db/schema.ts)、[migrations.ts](../packages/library/src/db/migrations.ts) |
| Issue、PRD 与分类标签 | [Issue 约定](agents/issue-tracker.md)、[标签约定](agents/triage-labels.md) |
| 版本与发布 | [发布规范](VERSIONING_AND_RELEASE.md)、[更新日志](../CHANGELOG.md) |
| 第三方集成与许可 | [第三方说明](THIRD_PARTY_NOTICES.md)、[MIT License](../LICENSE) |

提交改动时说明解决的问题、最终行为和验证结果。用户可见的功能与入口变化应同步更新使用指南；README 保持产品概览，版本细节记录在更新日志，实现约束留在对应设计文档。

### 局域网 Web 端

浏览器入口与桌面 renderer 独立，构建、认证、只读目录约束和验证命令见 [LAN_WEB.md](LAN_WEB.md)。`npm run dev` 会先构建 Web 页面；`npm run web:dev` 可持续监听重建。
