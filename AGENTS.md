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
| 局域网 Web 页面、移动端交互 | [`docs/MOBILE_WEB_GUIDELINES.md`](docs/MOBILE_WEB_GUIDELINES.md) | — |
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

产品概览见根目录 `README.md`，日常操作见 `docs/USER_GUIDE.md`，版本变化见 `CHANGELOG.md`。开发环境与技术文档索引见 `docs/DEVELOPMENT.md`，MetaTube 用户配置见 `docs/METATUBE_SETUP.md`。新增功能时按文档职责更新，避免把实现细节堆入 README。

## Agent skills

### Issue tracker

Issue 与 PRD 统一记录在 GitHub Issues。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认分类标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

采用单上下文领域文档布局。详见 `docs/agents/domain.md`。
