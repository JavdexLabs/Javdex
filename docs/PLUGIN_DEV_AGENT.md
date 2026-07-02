# Plugin Dev ReAct Agent

Javdex 内置的插件开发 Agent，通过 **ReAct 工具循环** 替代旧的单次 JSON 生成路径。Agent 可自主调用浏览器探测、修改插件代码、dry-run 与语义验证，直到 `plugin_finish` 满足硬结束条件。

## 架构

```
设置页 PluginDevPanel
  → IPC PLUGIN_DEV_AGENT_START / MESSAGE / CANCEL
  → runner.ts（ReAct 主循环）
  → deepSeekTools.ts（DeepSeek Chat Completions + tools）
  → toolExecutor.ts（14+ 工具分发）
  → scrapeBrowser / pluginDevService / pluginDevVerification
  ← PLUGIN_DEV_AGENT_EVENT（进度流）
```

核心模块：

| 路径 | 职责 |
|------|------|
| `src/shared/pluginDevKindProfile.ts` | video/actress 共享配置（标签、prompt 片段、testTargets 工具） |
| `src/main/services/pluginDevAgent/` | Agent 主循环、工具、Session |

## 工具列表

### 插件

- `plugin_get_state` — 当前包、测试目标、最近 dry-run / 验证
- `plugin_update_code` — 更新 parse 源码
- `plugin_update_package` — 更新元数据
- `plugin_dry_run` — 调试运行（`testTarget` / `testTargets`）
- `plugin_verify` — 语义 + 结构验证
- `plugin_install` — 安装到用户插件目录
- `plugin_finish` — 声明结束（`success=true` 需 dry-run 与 verify 均通过）

### 浏览器

- `browser_fetch_page` / `browser_html` / `browser_inspect` / `browser_evaluate`
- `browser_click` / `browser_type` / `browser_press` / `browser_wait` / `browser_status`

### 会话

- `session_note` — 记录页面观察笔记
- `session_request_user` — 暂停等待用户（Cloudflare 等）

## UI 使用

1. 在 **设置 → 开发工作台** 填写 API Key、站点名、支持字段、测试目标（番号或演员名，可多行/逗号分隔）。
2. 点击 **Agent 开发** 启动（有代码时为 debug 模式，无代码时为 create）。
3. 右侧 **工具时间线** 实时展示每步工具调用；`package_updated` 会同步编辑器。
4. 若出现 Cloudflare 验证，点击 **验证完成，继续** 发送继续消息。

## MCP 连接（可选）

安装依赖后可通过 stdio MCP 暴露同一套工具 schema：

```bash
npm run mcp:plugin-dev
```

环境变量（可选，用于初始化会话）：

| 变量 | 说明 |
|------|------|
| `AV_PLUGIN_DEV_KIND` | `video`（默认）或 `actress` |
| `AV_PLUGIN_DEV_SITE_NAME` | 站点名 |
| `AV_PLUGIN_DEV_SITE_URL` | 首页 URL |
| `AV_PLUGIN_DEV_TEST_TARGETS` | 测试目标，多个可用空格/逗号分隔 |
| `AV_PLUGIN_DEV_TEST_CODE` | （兼容）video 单个测试番号 |
| `AV_PLUGIN_DEV_TEST_ACTRESS` | （兼容）actress 单个测试演员名 |
| `AV_PLUGIN_DEV_SUPPORTED_FIELDS` | 逗号分隔字段列表 |

### OpenCode / Cursor 示例

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

> **注意**：MCP 进程独立启动时无法使用 Electron 内嵌浏览器窗口。`browser_*` 工具需要 Javdex 主进程中的 `scrapeBrowser` 已初始化。推荐在应用内使用 Agent；MCP 更适合在外部 IDE 中查看/调用与内部一致的 tool schema，或配合已运行的主程序（未来可扩展 IPC 桥接）。

## Cloudflare 验证

当 `browser_fetch_page` 或 `browser_status` 检测到 challenge 页面时，工具返回 `code: CHALLENGE`。Agent 应调用 `session_request_user`，UI 显示横幅后用户完成验证并点击继续。

## 测试

```bash
npm test
```

包含 `pluginDevKindProfile.test.ts`、`runner.test.ts`（mock LLM 结束规则）与 `toolExecutor.test.ts`（状态/笔记/代码更新）。
