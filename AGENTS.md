# Agent Instructions

面向在本仓库内改代码的 AI / Cursor Agent。按任务类型阅读对应文档，不必每次读完 `docs/` 下全部文件。

## 通用原则

- 改动范围尽量小，与周边代码风格和抽象层级保持一致。
- 样式优先使用 `src/renderer/src/styles.css` 中的语义 token（`--surface-*`、`--text-*`、`--control-*` 等），避免硬编码颜色与尺寸。
- 保持界面密集、安静、工具化，与现有 Electron 媒体库 UI 一致。

## 按任务阅读

| 你在改什么 | 必读 | 可选 |
|------------|------|------|
| UI、布局、样式、交互、无障碍 | [`docs/UI_DESIGN_GUIDELINES.md`](docs/UI_DESIGN_GUIDELINES.md) | [`docs/UI_COMPONENT_CONTRACTS.md`](docs/UI_COMPONENT_CONTRACTS.md) |
| 列表/详情页、路由、URL 筛选、返回栈 | [`docs/ROUTING_DESIGN.md`](docs/ROUTING_DESIGN.md) | `UI_COMPONENT_CONTRACTS.md`（若动 toolbar/筛选） |
| 刮削插件、`bundled-plugins`、沙箱 `ctx`、导入包 | [`docs/SCRAPER_PLUGIN_FORMAT.md`](docs/SCRAPER_PLUGIN_FORMAT.md) | — |
| 插件开发 Agent、`PluginDevPanel`、MCP、`pluginDevAgent/*` | [`docs/PLUGIN_DEV_AGENT.md`](docs/PLUGIN_DEV_AGENT.md) | `SCRAPER_PLUGIN_FORMAT.md` |
| 数据库表结构、迁移 | `src/main/db/schema.ts`、`src/main/db/migrations.ts` | — |

## 不必引导 Agent 通读

- **`PLUGIN_DEV_AGENT.md`**：仅在与应用内插件开发助手或 MCP 相关的代码时使用；改普通页面/服务无需读。
- **`SCRAPER_PLUGIN_FORMAT.md`**：仅在编写或修改刮削插件及插件运行时；与插件无关的功能不必读。

## 文档分工（避免重复）

- **`UI_DESIGN_GUIDELINES.md`** — 设计原则与 token 模型。
- **`UI_COMPONENT_CONTRACTS.md`** — 页面/组件结构约定与重构检查清单（配合 Guidelines 使用）。
- **`ROUTING_DESIGN.md`** — 嵌套路由、query state、navigation helper。
- **`SCRAPER_PLUGIN_FORMAT.md`** — 插件包格式与沙箱 API（产物规范）。
- **`PLUGIN_DEV_AGENT.md`** — 开发助手工作流与工具说明（生产工具）。

产品功能与版本说明见根目录 `README.md`、`CHANGELOG.md`。

## Cursor Cloud specific instructions

Javdex 是 Electron 桌面应用（主进程 + preload + React 渲染进程）。Node 22 已就绪，依赖由启动更新脚本 `npm install` 安装（`postinstall` 会用 `electron-rebuild` 针对 Electron 重新编译原生模块 `better-sqlite3`）。标准命令见 `README.md` 与 `package.json` scripts，此处只记非显而易见的云端注意事项：

- **测试 / 类型检查**：`npm test`（= `typecheck:node` + 通过 Electron 以 Node 模式运行的单元测试）。测试用 `ELECTRON_RUN_AS_NODE=1` 运行，**不需要显示器**。本仓库没有 ESLint；“lint”即 `npm run typecheck`（另有 `npm run check:encoding`）。
- **构建**：`npm run build`（electron-vite build）。
- **运行 GUI（`npm run dev`）需要显示器**：VM 上有 TigerVNC 桌面在 `DISPLAY=:1`（computer-use 可见）。运行前 `export DISPLAY=:1` 再 `npm run dev`，Electron 窗口才会出现在该桌面上。用 `xvfb-run` 会创建独立的隐藏显示，computer-use 看不到。启动日志里的 `bus.cc ... Failed to connect to the bus` 和 `Exiting GPU process` 报错在无头/VNC 环境下是正常的，可忽略。
- **数据位置**：`userData` 在 `~/.config/Javdex`；设置为 `~/.config/Javdex/settings.json`，SQLite 库为 `~/.config/Javdex/data/library.db`。要重置状态，停止应用后删除该 db 文件即可（下次启动会重建）。
- **非交互配置扫描路径**：设置里的“添加路径”按钮打开的是系统原生文件夹选择框，在 VNC 下自动化不可靠。要给 computer-use / 脚本准备可扫描的媒体库，直接预写 `~/.config/Javdex/settings.json`（应用启动前），例如 `{"libraryPaths":["/path/to/media"],"minScanImportDurationMinutes":0}`。`minScanImportDurationMinutes` 默认 30，会跳过短于 30 分钟的文件；测试用短视频时务必设为 0。
- **可被扫描识别的文件**：扩展名见 `src/main/scanner/codeParser.ts` 的 `VIDEO_EXTENSIONS`；文件名需含可解析的番号（如 `ABC-123.mp4`）才会导入。
