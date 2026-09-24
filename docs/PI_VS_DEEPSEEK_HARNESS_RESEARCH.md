# Pi 与 DeepSeek Harness 集成对比

> 调研日期：2026-08-20
>
> Pi 发布版：[`earendil-works/pi v0.84.2@914cf14`](https://github.com/earendil-works/pi/releases/tag/v0.84.2)；调研时主分支快照：[`ee29aa1`](https://github.com/earendil-works/pi/commit/ee29aa118bdeb7d8c4fdafa81130e0c61f8e0423)
>
> DeepSeek Harness 调研时主分支快照：[`141eb6f`](https://github.com/deepseek-ai/deepseek-harness/commit/141eb6fef83422698aef7a981029e843e8161534)；npm `latest` 为 `0.1.0-rc.7`
>
> 目标：判断哪个项目更适合替代 Javdex 内置刮削插件开发 Agent 的通用 Agent loop。Javdex 现状依据 [`PLUGIN_DEV_AGENT.md`](./PLUGIN_DEV_AGENT.md)，DeepSeek Harness 的既有分析依据 [`DEEPSEEK_HARNESS_INTEGRATION_RESEARCH.md`](./DEEPSEEK_HARNESS_INTEGRATION_RESEARCH.md)。
>
> 后续架构与迁移顺序见 [`AGENT_PLATFORM_EXECUTION_PLAN.md`](./AGENT_PLATFORM_EXECUTION_PLAN.md) 和 [`ADR-0020`](./adr/0020-establish-agent-platform-seams-before-pi.md)；执行计划采用“Javdex 产品控制面 + Pi Agent 数据面”，RuntimePort 仅隔离 Pi 类型，legacy runner 留在具体 `PluginDeveloper` 兼容 backend。

## 结论

**对 Javdex 当前形态，Pi 比 DeepSeek Harness 更合适。** 如果要选择一个候选进行集成，优先级应改为：

1. 使用 `@earendil-works/pi-coding-agent` 的工作中 API `createAgentSession()`，直接嵌入升级后的 Electron 主进程；
2. 将 Javdex 现有 18 个工具包装成 Pi `customTools`，继续直接调用 `executeTool()`、`scrapeBrowser`、dry-run 和 verify；
3. 保留现有 `runner.ts` 作为 feature flag fallback，固定 Pi 的确切版本；
4. **不要使用 Pi 新的 `AgentHarness` v2。** 上游明确把它称为“compile-complete scaffold”，尚未完成的操作会抛出 `HarnessNotImplemented`。[Pi agent-core changelog](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/CHANGELOG.md#0840---2026-08-06) · [当前实现](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/harness/agent-harness.ts)

Pi 的决定性优势不是模型效果，而是**集成边界与 Javdex 天然一致**：官方 SDK 就是给桌面应用和自定义 UI 同进程嵌入用的，工具是普通 TypeScript 闭包，拥有完整工具事件和 `abort()`；不需要 Harness sidecar、Cordis profile、MCP loopback 服务、随机鉴权 token 或跨进程事件映射。[Pi SDK](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md) DeepSeek Harness 的官方 TypeScript SDK 则明确驱动完整 runtime 子进程，且协议仍没有 turn cancel 或 session close。[DSH SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md#known-limitations-and-deferred-work) · [DSH SDK protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md#known-limitations-and-deferred-work)

这不等于 Pi 已经稳定到可以无保护替换。Pi 仍是 `0.x`，最近版本包含嵌入 API 的 breaking changes；推荐“**Pi 优先的受控 PoC**”，而不是立即删除现有 runner。[Pi v0.84.2 changelog](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/CHANGELOG.md#0840---2026-08-06)

## 一眼对比

| 维度 | Pi `createAgentSession()` | DeepSeek Harness sidecar | 对 Javdex 的判断 |
|---|---|---|---|
| 官方嵌入方式 | 同进程 TypeScript SDK；官方列出 desktop/custom UI 用例 | TypeScript SDK 启动完整子进程，通过 stdio JSON-RPC 驱动 | **Pi 明显更合适** |
| Javdex 工具接入 | `customTools` 直接闭包调用主进程服务 | 需要主进程 MCP/私有 IPC endpoint，再由 sidecar 调用 | **Pi 明显更简单** |
| 工具/UI 事件 | 文本、thinking、message、turn、tool start/update/end、queue、compaction、retry | 完整 durable `session.event` 能满足 UI | 两者都够，Pi 映射更直接 |
| 取消 | `AgentSession.abort()`；另有 `abortCompaction()`、`abortRetry()` | SDK wire 无 cancel/session-close，只能关闭 runtime | **Pi 更适合现有取消按钮** |
| 上下文压缩 | `AgentSession` 已有自动 compaction、overflow recovery、事件和可配置阈值 | 插件化 compaction，能力更通用 | 都有；Pi 接入成本更低 |
| 会话持久化 | 成熟 `SessionManager` JSONL/tree API；可先使用 in-memory | durable append-only event log 是核心设计，恢复模型更强 | Harness 架构更强，Pi 已够用 |
| provider | `pi-ai` 原生多 provider、可自定义 OpenAI/Anthropic-compatible endpoint | 多 provider 路线本身可使用 `dsh-llm-pi-ai` | **直接用 Pi 少一层** |
| Windows | 包与官方 binary 都支持 Windows；同进程时无需额外 runtime | JS 路线可运行，但 SDK 需要独立 runtime；官方 bundled runtime 交付仍是额外问题 | **Pi 更省打包工作** |
| 进程隔离 | 默认同 Electron main，故障会影响主进程 | sidecar 天然隔离、可强制回收 | Harness 胜出 |
| 权限/沙箱 | 官方明确没有内建 sandbox；由宿主限制工具 | 有更完整 sandbox、approval、capability seam | Harness 胜出；Javdex 可用严格工具 allowlist 缩小差距 |
| 成熟度 | 有正式 tag/release 和完整 SDK 文档，但仍为频繁 breaking 的 `0.x` | 官方仍标记 developer preview，并明示会破坏兼容 | **Pi 相对成熟** |
| 许可证 | MIT | MIT | 相同；分发都需保留 notice |

## Pi 中真正相关的三层

Pi 不是单一 CLI，而是分层 npm 包：[项目 README](https://github.com/earendil-works/pi/tree/v0.84.2)

- `@earendil-works/pi-ai`：模型/provider、流式消息、tool schema 与参数验证；
- `@earendil-works/pi-agent-core`：轻量 `Agent`、agent loop、工具执行、事件、steer/follow-up、abort；
- `@earendil-works/pi-coding-agent`：在 core 上补齐 `AgentSession`、持久会话、自动 compaction、retry、SDK/RPC 和资源加载。

### 不推荐只用 `pi-agent-core.Agent`

`Agent` 本身非常适合作为当前手写 ReAct loop 的薄替代：有流式事件、工具调用、参数验证、串行/并行执行、`beforeToolCall`/`afterToolCall`、`shouldStopAfterTurn`、`terminate`、steering 和 abort。[agent-core README](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/README.md)

但它把 `transformContext`、持久化与更高层 compaction 策略留给宿主。如果只接这一层，Javdex 仍要维护相当多会话与压缩编排，不完全符合“不再自己开发 Agent”的目标。

### 推荐 `pi-coding-agent.createAgentSession()`

官方明确将 SDK 定位为嵌入桌面/移动/自定义 UI 和自动化流程；`AgentSession` 管理 agent lifecycle、消息历史、模型状态、compaction 与事件流，公开 `prompt`、`steer`、`followUp`、`compact`、`abort` 和 `dispose`。[Pi SDK 概览](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md#sdk) · [`AgentSession`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md#agentsession)

它覆盖了当前 runner 中最不值得继续自研的部分：

- tool-calling loop 和逐 turn 继续；
- provider streaming 与跨 provider 消息转换；
- transient error retry 与 retry 生命周期事件；
- token threshold/overflow compaction；
- 消息、工具、队列、压缩、重试事件；
- 会话 JSONL、branch/tree 和恢复；
- 当前操作取消和等待 idle。

自动 compaction 会在 `contextTokens > contextWindow - reserveTokens` 时触发，默认保留近期消息并生成结构化摘要；threshold、overflow recovery 和 summarization retry 都已有实现与事件。[Pi compaction](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/compaction.md) Retry 可通过 `SettingsManager.inMemory()` 受控配置，无需读写用户的 Pi 全局设置。[SDK settings](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md#settings-management)

### 不推荐当前的 `pi-agent-core.AgentHarness`

名字容易造成误判：Pi 新增了另一个 durable `AgentHarness`，其目标设计包括 lane、可恢复 operation、JSONL/SQLite repo、compaction 和 crash recovery；但 `v0.84.2` 仍明确是 scaffold，源码中的 `prompt()`、`compact()`、`abort()`、`waitForIdle()` 等关键路径会调用 `unavailable()`。[AgentHarness specification](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/docs/harness.md) · [AgentHarness source](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/harness/agent-harness.ts)

因此本方案的候选是**已经工作的 `createAgentSession()`**，不是这个未完成的新 Harness。未来上游完成 durable Harness 后，可以重新评估用它替代较重的 coding-agent SDK。

## 与 Javdex 18 个工具的匹配

Pi 使用 TypeBox/JSON Schema 定义工具，参数会自动验证；TypeBox schema 可序列化为普通 JSON。[Pi tool schema](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/README.md#tools) Javdex 的 `PLUGIN_DEV_TOOL_SCHEMAS` 已经是受限的 object JSON Schema，因此转换主要是包装类型和返回值，不需要重新设计 18 个 schema。[本仓库 tool schemas](../apps/desktop/src/main/services/pluginDevAgent/toolSchemas.ts)

推荐的每个 wrapper 做法：

```ts
defineTool({
  name: schema.function.name,
  label: schema.function.name,
  description: schema.function.description,
  parameters: schema.function.parameters as TSchema,
  execute: async (_callId, args, signal) => {
    const result = await executeTool(sessionId, name, JSON.stringify(args), currentStep)
    if (!result.ok) throw new Error(result.content)
    return {
      content: [{ type: 'text', text: result.content }],
      details: result.structured,
      terminate: Boolean(result.finish || result.waitForUser)
    }
  }
})
```

Pi 工具执行函数原生收到 `AbortSignal`，可发送增量进度；抛出的错误会作为 `isError` tool result 返回给模型。[Pi AgentTool](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/README.md#tools) 但 Javdex 当前 `executeTool()` 不接收 signal，所以取消能立即停止 Agent/LLM，却未必终止已经进入 Electron 浏览器的底层操作；这个缺口对 Pi 和 DeepSeek Harness 都存在，应单独把 signal 逐步传入浏览器和 dry-run 服务。[本仓库 tool executor](../apps/desktop/src/main/services/pluginDevAgent/toolExecutor.ts)

必须注意两个配置点：

1. Pi 默认工具执行模式是 parallel，而 Javdex 的浏览器与插件包是共享有状态资源。应把所有 Javdex 工具设为 `executionMode: "sequential"`，或把整个 Agent 设为 sequential。[Pi tool execution](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/README.md#with-tool-calls)
2. 不要使用 `noTools: "all"`，它会禁用全部工具。应使用 `noTools: "builtin"` 保留 `customTools`，并最好再传 `tools: [18 个自定义工具名]` 建立显式 allowlist。[Pi SDK tools](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md#tools)

`session_request_user` 可以返回 `terminate: true`，让 Pi 在本批工具后停止自动发起下一次模型请求；用户完成 Cloudflare 后再调用 `session.prompt()` 继续。`plugin_finish` 同样可以终止当前 loop，而真正的 dry-run/verify finish gate 继续留在 Javdex 工具实现中，不能只依靠 prompt。[Pi termination semantics](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md#custom-tools)

这里有一个必须由 adapter 兜住的边界：只有同一批次中所有已完成工具结果都带 `terminate: true` 时，Pi 才会跳过自动 follow-up。应同时用 `session.agent.shouldStopAfterTurn` 检查 Javdex session 是否已进入 `waiting_user`/terminal 状态，并在 `beforeToolCall` 中拒绝 terminal 之后的同批 sibling 调用；不能只依赖单个工具结果的 `terminate` 提示。

## UI 事件与取消

Pi 已提供与 `PluginDevPanel` 高度对应的事件：

| Javdex 事件 | Pi 来源 |
|---|---|
| assistant text / thinking | `message_update` 的 `text_delta` / `thinking_delta` |
| step/turn | `turn_start` / `turn_end` |
| tool start/result | `tool_execution_start` / `tool_execution_update` / `tool_execution_end` |
| retry | `auto_retry_start` / `auto_retry_end` |
| compaction | `compaction_start` / `compaction_end` |
| done | `agent_settled`，然后检查 Javdex session/finish gate |

完整事件列在官方 SDK 文档中。[Pi SDK events](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md#events) `agent_end` 之后仍可能发生自动 retry、compaction retry 或 queued follow-up，因此产品侧完成态必须等待 `agent_settled`，不能看到 `agent_end` 就发送 `done`。[Pi extension event lifecycle](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md#agent_start--agent_end--agent_settled)

取消时不能只调用一个方法：

- `await session.abort()`：停止 retry 和当前 Agent，并等待 idle；
- `session.abortCompaction()`：单独停止正在进行的压缩；
- 清理/替换 session 时调用 `session.dispose()`，它会尝试停止 retry、compaction、branch summary、bash 和 agent。[Pi AgentSession source](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts)

相较之下，DeepSeek Harness 进程内 Agent 有取消能力，但 Javdex 推荐的进程外 SDK 协议没有 cancel 或 session-close，放弃 turn 只能关闭整个 runtime。[DSH SDK limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md#known-limitations-and-deferred-work) 这是 Pi 对当前产品交互的实质优势。

## Provider 与现有模型设置

Pi AI 支持 OpenAI、Anthropic、DeepSeek、Google、Bedrock、OpenRouter 等 provider，也支持任意 OpenAI-compatible endpoint。[Pi supported providers](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/README.md#supported-providers) 单 provider subpath import 只引入该 provider catalog 和 lazy API wrapper；官方明确建议打包应用只导入需要的 provider。[Pi provider factories](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/README.md#provider-factories) · [bundling](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/README.md#bundling-and-tree-shaking)

Javdex 不应启用 Pi 自己的 `~/.pi/agent/auth.json` 作为第二套设置，而应：

- 用 `ModelRuntime.create()` 配合 in-memory credential store、`modelsPath: null` 和关闭不必要的 catalog network refresh，建立 Javdex 私有模型运行时；
- 将当前 OpenAI-compatible 或 Anthropic 设置映射成 `createProvider()` + 一个明确的 `Model`，再通过 `ModelRuntime.registerNativeProvider()` 注册；
- API key 使用 in-memory credential/runtime override，不落到 Pi 默认目录；
- 为自定义模型明确提供 `contextWindow`、`maxTokens` 和 compatibility flags。

`createProvider()` 是官方支持的自定义 OpenAI/Anthropic-compatible 入口；coding-agent 的 `ModelRuntime` 实现 `Models` 并公开 `registerNativeProvider()`。[Pi custom providers](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/README.md#custom-providers) · [ModelRuntime source](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/model-runtime.ts)

DeepSeek Harness 的多 provider 插件之一正是 `dsh-llm-pi-ai`，因此 Javdex 直接使用 Pi 等于保留相同的底层 provider 能力，同时省掉 Cordis/runtime/SDK wire 三层。[DSH pi-ai adapter](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)

## Electron、Windows 与运行时

Pi 的三个相关包都要求 Node `>=22.19.0`。[pi-agent-core package](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/package.json) · [pi-coding-agent package](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/package.json) 这与 DeepSeek Harness 的最低要求相近。用户已接受升级 Electron；升级到内置 Node 满足该条件的受支持 Electron 后，Pi 可以直接运行于 Electron main，不需要额外 `node.exe` 或 `ELECTRON_RUN_AS_NODE` sidecar。Electron 版本与 Node 对应关系应在升级时按官方 schedule/release 核对。[Electron release schedule](https://releases.electronjs.org/schedule)

Pi 的官方发布构建脚本覆盖 `windows-x64` 和 `windows-arm64`，说明上游把 Windows 当作正式交付平台；源码也有 Windows 专项测试和进程处理。[Pi binary targets](https://github.com/earendil-works/pi/blob/v0.84.2/scripts/build-binaries.sh) 对 Javdex 推荐的同进程 SDK 路线而言，这些独立 binary 不需要随包分发，但它们降低了平台未知性。

DeepSeek Harness 的 TypeScript SDK则要求调用方显式提供 runtime `command/args`，并明确不负责 bundled-runtime resolution。[DSH TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md) 即便 Electron 已升级，按官方公开消费面仍然是 sidecar 路线；直接把 Cordis 插件树嵌入 main 会重新承担内部装配和兼容责任。

## 包体估算

以下是 2026-08-20 在 Windows 上对 npm `0.84.2` 的本地测量；使用 `npm install --ignore-scripts --no-save`，对生产依赖闭包逐文件求和，再以 ZIP optimal 作为安装器压缩量级参考。它不是 electron-builder 的最终产物大小。

| 方案 | 未压缩依赖闭包 | ZIP 参考 | 对安装器的工程估算 |
|---|---:|---:|---:|
| `pi-agent-core` 完整 npm 闭包 | 59.5 MiB | 16.3 MiB | 约 +15–20 MiB；但需自行保留更多 session/compaction 编排 |
| `pi-coding-agent` 完整 npm 闭包 | **91.8 MiB** | **28.4 MiB** | 未裁剪约 **+25–30 MiB** |
| `pi-coding-agent` 按 Javdex 需求打包/裁剪 | 预计 35–65 MiB | — | 约 **+12–20 MiB** |
| 既有 DeepSeek Harness 方案 | 约 40–60 MiB（生产裁剪估算） | — | 约 **+12–25 MiB** |

作为 tree-shaking 可行性实验，只导入 `Agent`、`createModels()`、OpenAI 和 Anthropic provider 的 esbuild Node/ESM/minified 分包总计约 **0.59 MiB**；只导入推荐 coding-agent SDK 的核心符号得到约 **6.17 MiB JS**。后者没有包含所有运行时资源/原生载荷验证，所以不能直接当作安装器增量，但说明 91.8 MiB 不是不可压缩的下限。Pi 官方也明确提供 selective provider imports 和 tree-shaking 指引。[Pi bundling guide](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/README.md#bundling-and-tree-shaking)

当前 Javdex main 使用 `externalizeDepsPlugin()`；若只是把 Pi 放进 dependencies 而不调整 externalization，electron-builder 更接近携带完整 npm 闭包。生产方案应显式把需要的 Pi 包纳入 main bundle，保留动态 chunk，并排除 docs、source maps、声明文件、TUI 图片以及未使用 provider/runtime 资源。[Javdex Vite config](../electron.vite.config.ts) 最终仍需用真实 NSIS/portable 构建验证，所以建议暂按 **安装器 +12–20 MiB** 预算，而不是用 0.59/6.17 MiB 实验值承诺产物。

## 安全边界

Pi 官方明确说明没有内建权限系统或 sandbox，默认继承启动用户/进程的权限；项目 trust 也不是运行时沙箱。[Pi permissions](https://github.com/earendil-works/pi/tree/v0.84.2#permissions--containerization) · [Pi security](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/security.md) DeepSeek Harness 在 sandbox、approval 和 capability seam 方面更完整，这是它真正胜过 Pi 的地方。[DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#capability-seams)

不过 Javdex 不是让 Agent 任意操作源码仓库，而是只开放 18 个受控领域工具。推荐配置：

- `noTools: "builtin"`，不加载 read/bash/edit/write/grep/find/ls；
- `tools` 显式列出 18 个 Javdex tool names；
- 不使用默认 `DefaultResourceLoader` 的用户/项目发现结果，提供最小 ResourceLoader 或严格受控配置，避免加载用户 `~/.pi` / 项目 `.pi` extensions、skills 和 prompts；默认发现行为见 [SDK ResourceLoader](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md#resourceloader)；
- 所有工具 sequential，未知工具 fail closed；
- `plugin_install`、`plugin_finish` 的不变量继续由工具实现强制执行；
- 凭据只保存在 Javdex 现有设置/内存，不使用 Pi shell credential resolution；
- 对事件日志中的网页内容和 API 响应沿用现有工作日志敏感数据策略。

在这个受限组合下，Pi 没有 sandbox 的风险可被 Javdex 自身工具边界显著收敛；如果未来开放 bash、文件系统、任意网络或无人值守 subagent，则应重新考虑 sidecar/OS sandbox，此时 DeepSeek Harness 的架构优势会更重要。

## 成熟度判断

Pi 有版本化 GitHub Releases、npm 包、checksummed source archives、Windows/macOS/Linux standalone 构建和公开 SDK 文档；`v0.84.2` 发布后主分支仍快速迭代。[Pi release](https://github.com/earendil-works/pi/releases/tag/v0.84.2) · [release/build policy](https://github.com/earendil-works/pi/tree/v0.84.2#building-standalone-binaries-from-release-source)

但不能把它视作稳定 API：

- 版本仍为 `0.x`；
- `0.84.0`、`0.82.0`、`0.81.0` 等近期版本均记录了 breaking changes；
- 新 `AgentHarness` 的 session API 在持续重做，而且关键行为未实现。[agent-core changelog](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/CHANGELOG.md)

因此应只依赖较成熟的 `createAgentSession`/`AgentSession` surface，并用 adapter 隔离上游。`package.json` 固定精确版本，`package-lock.json` 固定传递依赖，升级必须运行完整 create/debug/Cloudflare/cancel 回归。

DeepSeek Harness 的风险更高：官方仍明确标记 developer preview，并写明会有 compatibility-breaking changes；SDK 协议没有版本协商、cancel 或 session-close。[DSH README](https://github.com/deepseek-ai/deepseek-harness#developer-preview) · [DSH protocol limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md#known-limitations-and-deferred-work) 因而原“等待 Harness 稳定”的决策仍合理，但现在不必把它当成唯一候选。

## 推荐架构

```text
PluginDevPanel
  -> 现有 pluginDev IPC / PluginDevAgentEvent
      -> PluginDevAgentBackend
          -> builtin backend（现有 runner，fallback）
          -> pi backend
              -> createAgentSession()，运行在 Electron main
                  -> Javdex 私有 Models/provider（复用现有模型设置）
                  -> noTools: "builtin"
                  -> tools: [18 个 Javdex 工具名]
                  -> customTools -> executeTool()
                      -> sessionStore / scrapeBrowser / dry-run / verify / install
```

Pi backend 建议：

- `SessionManager.inMemory()` 起步，避免 PoC 同时改变持久化语义；确认价值后再将 JSONL 放到 `userData/plugin-dev-agent/sessions`。官方同时支持 in-memory、新建、继续和打开特定 JSONL。[Pi session management](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md#session-management)
- `SettingsManager.inMemory()` 显式设置 compaction/retry，不读取用户 Pi 配置。
- 自定义/最小 ResourceLoader，只提供 Javdex system prompt 与必要 context。
- 全局或逐工具设置 sequential。
- `turn_start` 维护 Javdex step 计数；`shouldStopAfterTurn`/宿主计数继续执行 `pluginDevAgentMaxSteps`。
- `session_request_user` 和 `plugin_finish` 用 `terminate` 停止自动 follow-up。
- cancel 同时处理 agent、compaction 和 Javdex 浏览器调用。

## 仍然属于 Javdex 的工作

无论选 Pi 还是 DeepSeek Harness，下列内容都不能外包给通用 harness：

- 18 个领域工具和 Electron 浏览器控制；
- 插件 package/session 状态；
- 增量代码编辑保护；
- dry-run 后自动 verify；
- `plugin_finish(success=true)` 的 fail-closed 门槛；
- Cloudflare 等待/继续交互；
- UI 事件映射与工作日志；
- provider 设置到精确模型元数据的映射。

Pi 能消除的是手写 LLM/provider loop、工具批次、消息协议、压缩、retry、队列与大部分 session orchestration。相比 DeepSeek Harness，它让 Javdex 只维护一个进程内 adapter，而不是 adapter + runtime 打包 + SDK protocol + MCP bridge。

## 建议的决策与验证门槛

**选择结论：Pi 胜出，DeepSeek Harness 保留观察。**

如果近期仍不准备集成，后续重新评估时应先检查 Pi，而不是只等 DeepSeek Harness：

1. Electron 已升级到满足 Node `>=22.19` 的受支持版本；
2. 固定一个 Pi release，`createAgentSession`、events、customTools、abort 在连续两个版本没有破坏性变化；
3. 最小 PoC 能在不改变 `PluginDevPanel` 核心交互的情况下完成真实 create/debug；
4. built-in tools、默认 extension/skill discovery 均被关闭，模型只能看到 18 个 allowlisted tools；
5. Cloudflare wait/resume、max steps、cancel、compaction、provider retry 全部有回归测试；
6. 真实 Windows NSIS/portable 构建的安装器增量控制在 **12–20 MiB** 目标内；
7. 同一批 fixture 对比现有 runner 的完成率、token、耗时与错误恢复，收益足以覆盖 adapter 维护成本。

只有当未来需求转向通用 coding agent、复杂 subagent、可热插拔能力图、强 sandbox/approval 或必须通过独立进程隔离故障时，DeepSeek Harness 才更可能反超。对于当前“Electron 主进程里已有完备领域工具，只想替换 Agent loop”的问题，Pi 的同进程 SDK 是更短、更可控的路径。
