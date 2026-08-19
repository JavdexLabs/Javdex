# 插件开发 Agent

Javdex 内置的 **Pi 驱动插件开发助手**：自主调用浏览器探测、修改插件代码、dry-run 与语义验证，直到 `plugin_finish` 满足结束条件。

> **插件代码规范**（包结构、`parseVideo`/`parseActress` 返回值、沙箱 `ctx` API）见 [`SCRAPER_PLUGIN_FORMAT.md`](./SCRAPER_PLUGIN_FORMAT.md)。Agent 产出与安装的代码必须符合该文档。
>
> **当前架构**：Javdex 是产品控制面，Pi `0.84.2` 是 Agent 数据面。边界与恢复契约见 [`AGENT_PLATFORM_EXECUTION_PLAN.md`](./AGENT_PLATFORM_EXECUTION_PLAN.md) 与 [`ADR-0020`](./adr/0020-establish-agent-platform-seams-before-pi.md)。

## 与格式文档的分工

| 文档 | 回答什么 |
|------|----------|
| `SCRAPER_PLUGIN_FORMAT.md` | 合法插件长什么样、沙箱里能用什么 API |
| 本文 | Agent 怎么跑、有哪些工具、UI/MCP 怎么用 |

## 架构

```
设置 → PluginDevPanel（/settings/plugin-dev）
  → IPC pluginDev:agentStart / agentMessage / agentCancel / agentSnapshot
  → PluginDeveloper（产品用例与状态投影）
  → AgentExecution（run/operation 幂等委托）
  → PiRuntimeAdapter → 长期 Pi AgentSession
  → ToolHost（权限 / 审批 / 锁 / ledger / 脱敏）
  → pluginDevAgent/toolExecutor.ts（18 个领域工具）
  → scrapeBrowser / pluginDevService / pluginDevVerification
  ← pluginDev:agentEvent（进度流）
```

| 路径 | 职责 |
|------|------|
| `src/shared/pluginDevKindProfile.ts` | video/actress 共享配置、测试目标、prompt 字段说明 |
| `src/shared/scrapeFieldPromptDocs.ts` | 字段 id 与返回键映射（注入 Agent prompt） |
| `src/main/services/pluginDevAgent/` | PluginDeveloper 用例、领域会话、ToolPack 与工具规则 |
| `src/main/agent-platform/` | 配置控制面、AgentExecution、ToolHost、持久化与 cache affinity |
| `src/main/agent-runtime/pi/` | 唯一允许引用 Pi 类型的 runtime adapter |

LLM 须在 **设置 → 模型** 中配置为支持 **工具调用**（`agentCompatible`）的供应商；API Key 与默认模型也在该处管理，而非插件工作台内单独填写。

## Agent 工具（18 个）

### 插件

| 工具 | 说明 |
|------|------|
| `plugin_get_state` | 当前包、测试目标、最近 dry-run/验证；默认不返回完整 code，需要时 `includeCode=true` |
| `plugin_update_code` | 更新源码；模式：`replace_snippet` → `replace_function` → `replace_all`（后者需充分理由） |
| `plugin_update_package` | 更新元数据（含 `supportedFields`） |
| `plugin_dry_run` | 沙箱试跑；`testTarget` / `testTargets` |
| `plugin_verify` | 结构 + 语义验证 |
| `plugin_install` | 安装到 `userData/scraper_plugins/`；不可与内置插件同名，不会覆盖内置插件 |
| `plugin_finish` | 结束会话；`success=true` 要求 dry-run 与 verify 均通过 |

### 浏览器

`browser_fetch_page`、`browser_html`、`browser_inspect`、`browser_evaluate`、`browser_click`、`browser_type`、`browser_press`、`browser_wait`、`browser_status`

开发期浏览器工具与插件沙箱内的 `ctx.fetchPage` / `ctx.browser` 均委托主进程 `scrapeBrowser`（见格式文档）。

### 会话

| 工具 | 说明 |
|------|------|
| `session_note` | 记录页面观察 |
| `session_request_user` | 暂停等待用户（如 Cloudflare 验证） |

## UI 使用

1. **设置 → 概览 → 刮削插件开发助手**，或 **设置 → 刮削插件** 中的开发入口 → `/settings/plugin-dev`
2. 填写站点名、首页 URL（可选）、`supportedFields`、测试目标（番号或演员名，多行/逗号分隔）
3. **AI开发**（无代码）或 **AI调试**（已有包）启动；也可在对话区输入指示
4. 右侧工具时间线展示每步调用；`package_updated` 同步左侧编辑器
5. Cloudflare 拦截时完成验证后点击 **验证完成，继续**
6. 对话区 **导出日志** 可保存完整 Agent 工作日志（JSON：时间线、未截断工具输出、包快照、dry-run/verify），用于分析工作流是否合理。renderer reload 与应用重启后会从产品快照和 journal 恢复。

Agent 的 Connection、Model、Preset、Route 与 Profile 在 **设置 → 模型** 中使用同一个配置 revision；compaction、retry 和 cache retention 在 run 开始时冻结。工作台只展示已解析的 Profile/Route，不自行猜默认 provider。

## MCP（可选）

```bash
npm run mcp:plugin-dev
```

通过 stdio 暴露与 Agent 相同的 tool schema（`PLUGIN_DEV_TOOL_SCHEMAS`），便于在外部 IDE 查看或调用。

| 环境变量 | 说明 |
|----------|------|
| `AV_PLUGIN_DEV_KIND` | `video`（默认）或 `actress` |
| `AV_PLUGIN_DEV_SITE_NAME` | 站点名 |
| `AV_PLUGIN_DEV_SITE_URL` | 首页 URL |
| `AV_PLUGIN_DEV_DESCRIPTION` | 插件描述 |
| `AV_PLUGIN_DEV_SUPPORTED_FIELDS` | 逗号分隔字段 id |
| `AV_PLUGIN_DEV_TEST_TARGETS` | 测试目标，空格/逗号分隔 |
| `AV_PLUGIN_DEV_TEST_CODE` | （兼容）单个番号 |
| `AV_PLUGIN_DEV_TEST_ACTRESS` | （兼容）单个演员名 |
| `AV_PLUGIN_DEV_ALLOW_INSTALL` | 设为 `1` 时，独立 MCP ToolHost 允许 install 无交互执行；默认仍要求审批并 fail closed |

```json
{
  "mcpServers": {
    "javdex-plugin-dev": {
      "command": "npm",
      "args": ["run", "mcp:plugin-dev"],
      "cwd": "/path/to/Javdex",
      "env": {
        "AV_PLUGIN_DEV_SITE_NAME": "tokyolib",
        "AV_PLUGIN_DEV_TEST_TARGETS": "MUKD-573 PRED-877",
        "AV_PLUGIN_DEV_SUPPORTED_FIELDS": "title,maker,publisher"
      }
    }
  }
}
```

**限制**：独立 MCP 进程无法使用 Electron 内嵌浏览器；`browser_*` 需主进程 `scrapeBrowser` 已初始化。**推荐在应用内使用 Agent**；MCP 主要用于对齐 tool schema 或外部编排。

## Cloudflare

`browser_fetch_page` / `browser_status` 检测到 challenge 时返回 `code: CHALLENGE`。Agent 应调用 `session_request_user`，用户验证后点击继续。

## 测试

```bash
npm test
```

相关用例：`pluginDevKindProfile.test.ts`、`pluginDevAgent/toolPack.test.ts`、`pluginDevAgent/toolExecutor.test.ts`、`agent-platform/*.test.ts` 与 `agent-runtime/pi/piRuntime.test.ts`。
