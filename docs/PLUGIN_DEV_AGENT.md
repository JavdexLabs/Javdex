# 插件开发 Agent

Javdex 内置的 **ReAct 插件开发助手**：自主调用浏览器探测、修改插件代码、dry-run 与语义验证，直到 `plugin_finish` 满足结束条件。

> **插件代码规范**（包结构、`parseVideo`/`parseActress` 返回值、沙箱 `ctx` API）见 [`SCRAPER_PLUGIN_FORMAT.md`](./SCRAPER_PLUGIN_FORMAT.md)。Agent 产出与安装的代码必须符合该文档。

## 与格式文档的分工

| 文档 | 回答什么 |
|------|----------|
| `SCRAPER_PLUGIN_FORMAT.md` | 合法插件长什么样、沙箱里能用什么 API |
| 本文 | Agent 怎么跑、有哪些工具、UI/MCP 怎么用 |

## 架构

```
设置 → PluginDevPanel（/settings/plugin-dev）
  → IPC pluginDev:agentStart / agentMessage / agentCancel
  → pluginDevAgent/runner.ts（ReAct 主循环）
  → llm/agentToolChatClient.ts（当前 LLM 供应商 + tool calling）
  → pluginDevAgent/toolExecutor.ts（18 个工具）
  → scrapeBrowser / pluginDevService / pluginDevVerification
  ← pluginDev:agentEvent（进度流）
```

| 路径 | 职责 |
|------|------|
| `src/shared/pluginDevKindProfile.ts` | video/actress 共享配置、测试目标、prompt 字段说明 |
| `src/shared/scrapeFieldPromptDocs.ts` | 字段 id 与返回键映射（注入 Agent prompt） |
| `src/main/services/pluginDevAgent/` | 会话、工具执行、上下文压缩 |
| `src/main/services/llm/agentToolChatClient.ts` | OpenAI Chat / Anthropic Messages 适配 |

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
| `plugin_install` | 安装到 `userData/scraper_plugins/` |
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

Agent 配置（最大步数、上下文 token 上限）可在工作台内保存至 `settings.json`（`pluginDevAgentMaxSteps`、`pluginDevAgentMaxContextTokens`）。

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

相关用例：`pluginDevKindProfile.test.ts`、`pluginDevAgent/runner.test.ts`、`pluginDevAgent/toolExecutor.test.ts`。
