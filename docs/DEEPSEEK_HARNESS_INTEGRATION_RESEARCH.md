# DeepSeek Harness 集成调研

> 调研日期：2026-08-15
> 上游快照：[`deepseek-ai/deepseek-harness@47f9438`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)（2026-08-13）
> 范围：是否用 DeepSeek Harness 提升 Javdex 内置刮削插件开发 Agent，而不再自行维护通用 Agent loop。本文只引用 DeepSeek Harness 官方仓库、官方发布页和 Electron 官方版本页；Javdex 现状引用本仓库文件。

## 项目决策（2026-08-15）

**暂缓集成，等待 DeepSeek Harness 稳定后重新评估。** 当前继续维护并使用内置 runner，不提前引入运行时依赖。重新评估时沿用本文的 `Electron main -> TypeScript SDK -> bundled Node 22.19+/24 sidecar -> MCP -> Javdex 主进程工具` 方案，并至少检查以下门槛：

- 上游提供可固定的稳定版本，不再处于 developer preview 或频繁破坏兼容阶段；
- SDK 具备逐会话取消能力，或已有经过验证的等价安全方案；
- Windows 安装包可离线、可重复地携带最小 runtime，且 sidecar 生命周期、签名与升级清理验证通过；
- 与现有 runner 的真实 create/debug 回归对比证明收益足以覆盖接入和维护成本。

对应代码待办记录在 `apps/desktop/src/main/services/pluginDevAgent/runner.ts`。在上述门槛满足前，不删除现有 runner，也不把 Harness 作为默认后端。

## 结论

**可以集成，但不能零适配地替换当前 `runner.ts`。推荐把 DeepSeek Harness 作为可选的外部 Agent runtime，与现有 runner 并存；先做 sidecar + MCP/私有 IPC 的验证，不建议现在直接替换。**

DeepSeek Harness 能接管的正是 Javdex 不想继续自研的通用部分：多步 agent loop、模型流式适配、事件溯源会话、上下文压缩、工具调度、重试、状态通知和插件化扩展。它明确把 agent loop、LLM、工具、持久化都做成可替换 Cordis 插件，能力边界比当前手写 ReAct loop 完整。[官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.zh.md)

但它不是一个接受 `requestChat()` 与 `executeTool()` 回调的轻量库。官方 TypeScript SDK 的定位是**启动并驱动一个完整的 Harness 子进程**，并明确要求调用方提供 `command`/`args`；官方没有面向 Electron 的进程内嵌入 API。[TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md) 当前 SDK 协议也没有“运行时反向调用宿主工具”的请求，因此 Javdex 仍须提供一层桥接，才能让 Harness 调用依赖 Electron `BrowserWindow` 的 18 个插件开发工具。[SDK 协议](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/protocol/README.zh.md)

因此合理的职责划分是：

- DeepSeek Harness 拥有通用 loop、LLM、历史、压缩、重试、事件与工具调度。
- Javdex 继续拥有插件包状态、浏览器控制、dry-run、语义验证、安装和完成门槛。
- 一层很薄但不可省略的 adapter 将 Harness 的工具调用转发到 Javdex 主进程，并把 Harness 事件映射到现有 `pluginDev:agentEvent`。

## 适配度判断

| 维度 | 判断 | 说明 |
|---|---|---|
| 通用 Agent 能力 | 高 | 默认 loop 已具备 turn/step、工具批次、steering、重试、上下文压缩、subagent 和事件流。 |
| Javdex 领域工具复用 | 中 | schema 容易转换，但工具必须在 Electron 主进程执行，需要跨进程桥。 |
| 现有 UI 复用 | 中高 | `session.event`/`session.status` 可驱动时间线；需做事件映射。 |
| 取消 | 中低 | Harness 进程内 `Agent.cancel()` 完整，但官方进程外 SDK 暂无逐提示词取消，只能关闭 runtime 或扩展协议。 |
| Windows 开发运行 | 中 | Node 版本满足时，源码/CLI 有 Windows 路径和 CI；但官方 Python bundled runtime 不提供 Windows 二进制。 |
| Electron 直接嵌入 | 低 | Javdex 当前 Electron 33.2.0 内置 Node 20.18.0，低于 Harness 要求的 Node 22.19。 |
| 生产成熟度 | 低至中 | 项目功能丰富，但官方仍标为 developer preview，明确会有破坏性变更；当前无 GitHub Release/Tag。 |
| 许可证 | 高 | MIT，可商用和修改；分发时保留版权/许可，并处理第三方 notices。 |

## 上游项目定位与成熟度

DeepSeek Harness 是 DeepSeek 官方开源的 agent harness，口号是 “Everything is a Plugin”。官方 README 将其标为 **developer preview**，并明确提示会发生兼容性破坏；推荐入口是 `npx @deepseek-ai/dsh web`，默认在 `127.0.0.1:3080` 提供 Web UI。[README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md)

本次固定快照中的根包版本为 `0.1.0-rc.5`，Node engine 为 `^22.19.0 || >=24.0.0`，使用 TypeScript/ESM、pnpm 11，并以大量独立 `@deepseek-ai/dsh-*` 包组成 monorepo。[根 `package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/package.json) 截至调研日，官方 GitHub [Releases](https://github.com/deepseek-ai/deepseek-harness/releases) 和 [Tags](https://github.com/deepseek-ai/deepseek-harness/tags) 页面均没有版本记录。它适合做受版本锁定的实验和可回退集成，暂不适合成为 Javdex 唯一且不可替换的核心运行时。

项目采用 [MIT License](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/LICENSE)。集成或重新分发上游代码/产物时应保留 MIT notice，并同步检查官方的 [`THIRD_PARTY_NOTICES.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/THIRD_PARTY_NOTICES.md)，不能只记录 DeepSeek 自身许可证。完整 base/CLI 闭包还可能携带有独立条款的平台载荷；采用最小 JSON-RPC runtime 不只是减小体积，也会缩小许可证审查面。[base bundle 的分发说明](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/base/README.md)

## 模型和 API 支持

官方有两条 LLM 路线：

1. `dsh-llm-deepseek`：原生 DeepSeek chat-completions 流式适配器，使用 `fetch` + SSE，注册 `deepseek-official` 路由；模型 id 原样传递，默认目录是 DeepSeek V4 Flash/Pro，可通过 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_BASE_URL` 指向官方或兼容网关。[DeepSeek 适配器](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/README.zh.md)
2. `dsh-llm-pi-ai`：通用多提供方适配器，官方配置示例覆盖 OpenAI、Anthropic、DeepSeek 和自定义 OpenAI-compatible gateway；官方模型配置指南还说明了 Bedrock、Vertex、Azure 和 Codex 等目录提供方的认证差异。[pi-ai 适配器](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-pi-ai/README.zh.md) · [模型配置指南](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/providers.zh.md)

进程外 SDK server 只会自动补挂 `deepseek-official`；选择其他 provider 时，必须在自定义 `cordis.yml` 中预先注册对应适配器。[SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/server/README.zh.md) 因而 Javdex 不能只把当前 provider/model 名透传过去，还要生成受控的 provider 配置，并安全映射现有模型设置与凭据。

## Agent loop、工具和扩展点

Harness 的一个 step 是一次模型请求及其工具调用，一个 turn 可包含多个 step。持久事件包括 `turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`；实时扩展点包括 `agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute` 和 `agent/turn-stopping`。[轮次生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/agent-lifecycle.zh.md)

默认 loop 本身**没有 turn/step 次数预算**；上游要求需要预算的产品通过生命周期扩展点取消失控轮次。[agent-loop 限制](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/README.zh.md) 所以 Javdex 的 `pluginDevAgentMaxSteps` 不能因迁移而消失，应实现为 step 观察/`agent/turn-stopping` 策略，或由宿主在达到预算时取消 runtime。

工具通过 `ctx.tools.register(defineTool(...))` 注册；参数 schema 会进入提示词，执行函数获得 `AbortSignal`，结果先经过规范 JSON schema 校验再渲染为模型内容。默认工具是独占执行，只有显式返回 `isConcurrencySafe: true` 才进入并发池；这与 Javdex 浏览器和插件包状态必须串行的约束相容。[添加工具](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/cookbook/adding-a-tool.zh.md) 工具调用还可经过审批、单调 guard、超时、结果改写和最终观察，适合承载插件安装确认、URL/域名策略和完成门槛。[工具执行流水线](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/tool-execution-pipeline.zh.md)

Javdex 的 `PLUGIN_DEV_TOOL_SCHEMAS` 可以机械转换成 Harness tool 或 MCP tool；真正需要迁移的是当前 `runner.ts` 内的领域编排：

- debug 启动时先 dry-run；
- 每次成功 dry-run 后自动 verify；
- `plugin_finish(success=true)` 必须满足 dry-run 与 verify；
- 无工具回复时要求模型继续使用工具；
- 重复 dry-run、代码未改变和验证失败的提醒；
- max steps、上下文压缩、进度事件和等待用户状态。

其中通用的上下文压缩、事件和生命周期可交给 Harness；其余规则应移入 Javdex 工具本体或 Harness hooks，而不能随旧 runner 一起删除。现有职责见 [`PLUGIN_DEV_AGENT.md`](./PLUGIN_DEV_AGENT.md)、[`runner.ts`](../apps/desktop/src/main/services/pluginDevAgent/runner.ts) 和 [`toolSchemas.ts`](../apps/desktop/src/main/services/pluginDevAgent/toolSchemas.ts)。

## 状态、会话、中断和事件流

Harness 会话是仅追加、事件溯源的日志；模型历史由日志投影生成，JSONL/SQLite 持久化、恢复、fork 和压缩均围绕同一事件流构建。[Session](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/README.zh.md) 这比 Javdex 当前只在内存保存 transcript、终态约一小时后清理更适合长任务和崩溃恢复。

进程内 `Agent` API 有 `followup`、`steer`、`inject`、`whenIdle()` 和接受原因/`keepInbox` 的 `cancel()`；取消信号会流入 LLM 与工具执行。[Agent handle](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/core.zh.md#agent-%E5%8F%A5%E6%9F%84)

但官方进程外 SDK 只暴露 `initialize`、`session/prompt` 和 `shutdown` 请求，以及 `session.event`、`session.status`、`subagent.started/finished` 通知；**没有逐提示词取消、逐会话关闭或严格的 prompt→response 因果结果**。高层 `run()` 只是从消息被接收到 agent 再次 idle 的活动区间，期间 steering 或其他排队工作也可能参与。[SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md) 采用 sidecar 时，Javdex 的第一版取消只能“关闭整个 runtime 子进程”，或自行扩展协议；不能把上游进程内取消能力误当成 SDK 已提供能力。

### SDK 与 ACP 的选择

上游还有 `@deepseek-ai/dsh-acp`，它同样通过 stdio JSON-RPC 驱动 Harness。ACP 的优势是协议内有 `session/cancel`、逐提示词等待和一次性权限请求；但官方把它定位为 **automation-only**，只输出已提交的 assistant 文本，明确不提供 transcript 回放、实时 token、推理、工具活动、计划、标题、信息征集和工具展示，而且只支持新会话。[ACP server](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/acp/acp/README.zh.md)

Javdex 的插件开发工作台需要工具时间线、Cloudflare 等待用户、会话继续和结构化工作日志，因此 **POC 应选 TypeScript SDK，而不是 ACP**。ACP 更适合未来把 Harness 暴露给外部编辑器，或让另一个 agent 把它当自动化子 agent；它不能单独支撑现有 `PluginDevPanel`。若后续精细取消成为硬需求，可参考 ACP 的 `session/cancel` 语义为 SDK sidecar 增加窄扩展，但不应为获得取消而放弃 SDK 的完整 `session.event` 流。

## 是否能嵌入 Node/Electron

### 直接在 Electron 主进程加载：不推荐

从源码看，Harness 各包本身是 TypeScript/ESM，理论上可以自行创建 Cordis context 并注册 Javdex 工具闭包。但这不是官方 SDK 支持的消费方式，而且会把大量插件装配、生命周期和版本兼容责任重新带回 Javdex。

更直接的阻塞是运行时版本：Harness 要求 Node `^22.19.0 || >=24.0.0`，而 Javdex 当前依赖 Electron `^33.2.0`，Electron 33.2.0 官方记录的内置 Node 是 20.18.0。[Harness engine](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/package.json) · [Electron 33.2.0](https://releases.electronjs.org/release/v33.2.0) 在不先升级 Electron 的情况下，不能把 Harness 的 Node runtime 安全地当作 Electron main-process 库加载。

### 外部进程：官方支持路径

`@deepseek-ai/dsh-sdk-client` 明确通过 stdio JSON-RPC 驱动子进程，`DeepSeekHarness` 负责惰性启动、复用与关闭；调用方显式传入 runtime 的 `command`/`args`。[TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md) `@deepseek-ai/dsh-sdk-jsonrpc-demo` 提供读取外部 `cordis.yml` 的公开 bin，stdout 必须只承载协议帧。[JSON-RPC runtime bin](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/examples/jsonrpc-demo/README.zh.md)

这条路径隔离版本与故障，也符合 Electron 的架构。但标准 SDK 只有 Javdex→Harness 控制通道，没有 Harness→Javdex 工具回调。推荐利用 Harness 官方 MCP client 的 `streamable-http` 或 `stdio` transport，把 Javdex 工具作为 MCP server 暴露给 sidecar；该插件会将 MCP tools 注册成 Harness 原生工具，并传递超时和取消信号。[Harness MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/mcp/mcp-client/README.zh.md)

Javdex 已有 stdio MCP server 和同一套工具 schema，但仓库文档也明确指出：独立 MCP 进程无法使用 Electron 内嵌浏览器。因此生产集成不能直接让 Harness spawn 现有 `npm run mcp:plugin-dev`；应由正在运行的 Electron 主进程托管一个仅本机可达、按会话鉴权的 MCP/IPC endpoint，工具最终仍调用主进程 `executeTool()`。[现有 MCP 限制](./PLUGIN_DEV_AGENT.md#mcp可选)

## Windows 和打包影响

上游 JS/CLI 代码并非整体不支持 Windows：官方仓库有 Node 24 的原生 Windows CI，并为 PowerShell/TUI 提供 Windows 路径。[官方 CI](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.github/workflows/ci.yml) 但官方 Python SDK 的预编译 runtime wheel 只列出 Linux x64/arm64 与 macOS arm64，且示例明确说明依赖 POSIX PTY 的组合不支持 Windows agent。[runtime 平台列表](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk-runtime/platforms.json) · [Python SDK 指南](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.zh.md)

因此 Javdex 的首选 Windows 路线不能依赖 Python SDK bundled runtime。需要在 `extraResources` 中随应用分发：

- 一份固定版本、按平台/架构构建的 Node 22.19+/24 runtime；
- Harness runtime 的生产依赖闭包和自定义 `cordis.yml`；
- 必需的许可证/notices；
- 如选择含 native addon 的插件，还要按目标平台构建、解出 ASAR 并纳入签名/公证。

Javdex 目前 electron-builder 只打包 `out/**/*`，`extraResources` 只有图标，且启用 ASAR；所以 sidecar 需要新增明确的资源复制、路径解析、完整性检查和平台矩阵。见 [`electron-builder.config.mjs`](../electron-builder.config.mjs)。不要在生产版运行时调用 `npx` 临时下载 Harness：这会把可用性、版本漂移和供应链边界交给用户机器。

## 安全边界

Harness 提供审批、工具 guard、超时、文件系统与 subprocess sandbox seam，但安全取决于最终组合，并非启用 Harness 就自动安全。官方 Python SDK 的极简示例明确使用 `danger-full-access` 和裸本地文件系统，只建议在可丢弃 checkout 或容器中运行。[Python SDK 指南](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.zh.md)

Javdex 专用 runtime 应采用最小组合：只装 agent core、SDK server、选定 LLM adapter、持久化/压缩和 Javdex MCP tools；不要加载通用 bash、文件编辑、任意 web fetch、subagent 或工作流工具。还应满足：

- MCP/IPC 只绑定 loopback 或命名管道，以每次启动的随机 token 鉴权，并把 token 限定到一个 Javdex session。
- 工具 allowlist 必须来自 `PLUGIN_DEV_TOOL_SCHEMAS`，未知工具 fail closed；所有工具默认独占。
- 子进程环境使用显式 allowlist，不继承 Electron 的完整环境。官方 SDK 也指出，提供 `env` 时会整体替换子进程环境，凭据策略属于调用方。[SDK client 环境约定](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md)
- API key 只通过受控环境/凭据 seam 传给 sidecar，不写入 `cordis.yml`、事件日志或工具结果。
- DeepSeek 官方适配器会向解析后的 `baseURL` 发送 Harness attribution、匿名 user id，并在有会话时发送 session id；如果用户配置第三方 gateway，需把这一行为写进隐私说明或在自定义适配器/策略中处理。[DeepSeek 适配器归因](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-deepseek/README.zh.md#%E5%BA%94%E7%94%A8%E5%BD%92%E5%9B%A0)
- `session_root` 放在 Javdex `userData` 的独立目录，退出时显式 shutdown/flush；对日志中的页面内容、模型输出和用户指示执行与现有工作日志相同的敏感数据策略。

## 推荐集成方案

推荐引入一个 `PluginDevAgentBackend` seam，让 UI/IPC 不感知底层 loop：

```text
PluginDevPanel
  -> 现有 pluginDev IPC / 事件类型
      -> builtin backend（现有 runner，保留为 fallback）
      -> harness backend
          -> @deepseek-ai/dsh-sdk-client
              -> Node 22+/24 Harness sidecar + 专用 cordis.yml
                  -> dsh-mcp-client
                      -> Electron 主进程内的受控 Javdex MCP/IPC endpoint
                          -> 现有 sessionStore + executeTool + scrapeBrowser
```

不建议让 Harness 自带 Web UI 嵌进 Javdex，也不建议让 Harness 直接操作插件目录或浏览器。这样既保留 Javdex 的产品边界，又只把通用 Agent runtime 交给上游。

### 分阶段执行

1. **Spike（开发环境，单平台）**
   锁定一个上游 commit/确切包版本；用 TypeScript SDK 启动最小 JSON-RPC runtime；先注册一个无副作用测试工具，证明 prompt→tool→result→idle 与事件映射。
2. **工具桥接 POC**
   在 Electron 主进程托管带随机 token 的 loopback MCP endpoint；转发 18 个 schema 到现有 `executeTool()`。先覆盖 `plugin_get_state`、`plugin_update_code`、`plugin_dry_run`、`plugin_verify`、`plugin_finish`，再接浏览器工具。
3. **迁移领域规则**
   把自动 verify 和 finish gate 下沉到工具/hook；保留现有包状态、增量编辑保护、浏览器锁和工作日志。不要依赖 prompt 文字维持强制不变量。
4. **并存试运行**
   增加实验设置 `builtin | harness`；同一套 fixture 对两个 backend 跑 create/debug/Cloudflare wait/cancel/continue，比较成功率、token、耗时和错误恢复。
5. **打包验证**
   Windows x64 先行，验证安装版/ZIP 版离线启动、sidecar 回收、ASAR 路径、杀进程后的恢复和升级清理；再扩展 macOS/Linux。
6. **替换决策**
   只有上游出现可固定的稳定发布、Windows sidecar 交付可重复、取消方案落地，并且回归数据优于现有 runner 后，才把 Harness 设为默认；现有 runner 至少保留一个发布周期作为 fallback。

## Spike 验收门槛

- 不改 `PluginDevPanel` 的核心交互即可完成一次真实 create 或 debug 任务。
- 模型只能看到 Javdex allowlist 中的工具，无法调用 Harness 通用 shell/fs/web 工具。
- `plugin_finish(success=true)` 在 dry-run/verify 未通过时始终 fail closed。
- 浏览器工具一定在 Electron 主进程执行，Cloudflare 等待/继续仍可用。
- 取消后 5 秒内 sidecar 和工具调用均停止或进入可证明的稳定状态；无孤儿 Node 进程。
- 会话事件可以重建 UI 时间线；崩溃重启后不会盲目重复有副作用的安装/写入。
- Windows 安装版在未安装 Node/Python、无网络下载的干净环境中可运行。
- 上游升级只影响 backend/sidecar 层，不要求改 Javdex 领域工具和 UI 协议。

## 最终建议

**当前不启动集成 Spike。** 上游稳定性、逐会话取消和 Windows 离线打包等前置可行性门槛满足后，再按“并存 backend + 外部 sidecar + 主进程工具桥”路线做开发环境 Spike，并以真实 create/debug 回归数据决定是否正式集成；不要立即删除现有 runner，也不要把完整 Harness base profile 直接塞进 Electron。

这能显著减少 Javdex 对通用 Agent loop 的维护量，但不会消除领域适配工作。预计最值得交给 Harness 的部分是 loop、会话、压缩、重试和事件；Javdex 仍需维护的部分应被明确限制为工具桥、领域完成门槛和产品 UI。若目标是“完全不写任何 Agent 相关代码”，当前上游官方 SDK 和 Javdex 的 Electron 浏览器边界还达不到这一点。
