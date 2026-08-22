# Javdex Agent 控制面与 Pi 数据面接入执行计划

> 模型连接、模型目录和用途运行参数的用户配置已由
> [ADR-0022：模型管理 v3](adr/0022-model-management-v3.md) 取代。本文件中的
> Connection / Model / Preset / Route / Profile 配置章节仅保留为历史设计记录，不再描述当前设置界面或运行时配置源。

- 状态：Approved
- 日期：2026-08-20
- 目标：先收敛架构与模型配置，再把插件开发迁到 Pi；以后增加 Agent 与 ToolPack 时不复制运行时逻辑
- 相关决策：[ADR-0020](adr/0020-establish-agent-platform-seams-before-pi.md)
- 上游评估：[Pi 与 DeepSeek Harness 对比](PI_VS_DEEPSEEK_HARNESS_RESEARCH.md)
- 首个目标版本：精确锁定 @earendil-works/pi-coding-agent 0.84.2；升级必须单独验证

## 1. 最终结论

采用“Javdex 产品控制面 + Pi Agent 数据面”，不再建设 Javdex 自己的通用 Agent runtime。

Javdex 只拥有产品事实、模型与工具治理、领域规则和可见记录。Pi 独占会话内的模型循环、消息转换、工具批次、retry、compaction、overflow recovery、queue 与 settled 判定。

最重要的运行约束是：

1. 一个 Javdex Agent run 创建一个长期存在的 Pi AgentSession。
2. create、debug、普通反馈、continue、steer、follow-up 与审批恢复复用同一对象；不会为每个 operation 重建 session。
3. 正常恢复优先打开 Pi SessionManager 保存的 session/checkpoint。
4. Javdex ExecutionHistory 只是冷后备和审计记录；只有 Pi checkpoint 明确损坏或不兼容时才由 Pi adapter 消费它重建一次。
5. AgentExecution 不拥有 turn loop，不调用低层 continue，不压缩 transcript，也不重试 provider。
6. legacy runner 只留在 PluginDeveloper 的迁移分支，不实现 RuntimePort，不伪装成通用 runtime。

修订后的完整工作量为单人约 **31–45 个工程日（约 6–9 周）**，包含测试和 Windows 安装包验证；Pi 成为 opt-in backend 约需 27–39 个工程日。成为默认 backend 后仍保留两个稳定版本的观察期，该观察期不计入工程日。

## 2. 不可突破的边界

### 2.1 Javdex 拥有

- Agent runId、operationId、产品状态、幂等键与持久化。
- ModelControlPlane、AgentConfiguration、模型路由、凭据租约与能力校验。
- ToolHost、授权、审批、资源锁、脱敏与副作用 ledger。
- PluginDeveloper 的 dry-run、verify、finish、wait、install 等领域规则。
- ProductJournal、artifact、工作日志与 UI 产品事件。
- ExecutionHistory 的加密存储、完整性和 retention；其中的 runtime recovery payload 由 adapter 编解码。

### 2.2 Pi 独占

- LLM streaming、provider 请求协议与跨 provider 消息转换。
- tool-calling loop、下一轮模型请求与同一 assistant message 内的工具批次。
- provider retry、session retry、summary retry。
- 自动/手动 compaction、overflow recovery、summary 与截断。
- Agent transcript、runtime message 顺序、tool-call/result pairing。
- prompt cache 的实际 provider 参数与 session affinity 发送。
- steer、follow-up、queue、abort、runtime session 与 agent_settled。

### 2.3 明确不做

- 不建立 workflow DSL、通用 state-machine builder 或动态 Agent marketplace。
- 不实现 Javdex ReAct loop、next-turn scheduler、provider streaming adapter 或 transcript compressor。
- 不承诺把正在运行的 Pi session 无损迁移到任意未来 runtime。
- 不让 shared、preload、renderer、用例模块或领域模块引用 Pi 类型。
- 不启用 Pi built-in tools、extensions、skills、prompt templates、themes 或 context discovery。
- 不把缓存命中率作为唯一优化目标。

## 3. 修订后的模块职责图

~~~mermaid
flowchart LR
  UI[Renderer / typed IPC] --> PD[PluginDeveloper<br/>具体用例 Interface]
  PD --> WF[PluginDeveloperWorkflow<br/>dry-run / verify / finish / wait]
  PD --> AE[AgentExecution<br/>run/operation 编排<br/>产品状态投影]

  AC[AgentConfiguration<br/>Definition / Profile / ToolPack refs] --> AE
  MC[ModelControlPlane<br/>route / capability / credential lease] --> AE
  MC --> MI[ModelInvocation<br/>仅非 Agent JSON/翻译/验证调用]

  AE --> RP[AgentRuntimePort<br/>薄 session seam]
  RP --> PA[PiRuntimeAdapter<br/>Pi 类型 locality]
  PA --> PS[Pi AgentSession<br/>loop / queue / retry / compaction<br/>streaming / agent_settled]
  PA <--> PSS[Pi SessionManager<br/>首选 runtime state]

  PS -->|custom tool callback| TH[ToolHost<br/>policy / approval / lock / ledger]
  TH --> CA[Capability adapters<br/>browser / file / plugin / network]
  WF --> TH

  PS -->|normalized observations| AE
  AE --> ARS[AgentRunStore<br/>run snapshot / ProductJournal<br/>ExecutionHistory / artifacts]
  TH --> ARS
  ARS --> UI
~~~

这不是一个宽 AgentPlatform façade。每个 Module 的 Interface 都隐藏内部复杂度：

- PluginDeveloper 对外拥有插件领域 policy。
- AgentExecution 只把产品命令投递给一条长期 runtime session，并把观察结果投影成产品状态。
- PiRuntimeAdapter 隐藏第三方 API 差异，但不拥有产品规则。
- ToolHost 是所有有副作用能力的唯一入口。
- AgentRunStore 是一个持久化 deep module，不拆成四套公共 repository Interface。

## 4. Pi / Javdex ownership 表

| 关注点 | Javdex owner | Pi owner | 边界规则 |
|---|---|---|---|
| run / operation 身份 | AgentExecution | — | runId 与 operationId 不进入 Pi 的产品语义 |
| 产品状态 | 具体用例 + AgentExecution | — | Pi event 只能触发投影，不能直接定义 finished/failed/waiting |
| runtime session | 保存 opaque ref 与活动 handle | AgentSession + SessionManager | 同一 run 长期复用同一 session |
| transcript 与消息顺序 | ExecutionHistory 只保存冷恢复/审计副本 | 唯一活动事实源 | 正常 operation 永不从 History 重建 |
| route 与模型能力 | ModelControlPlane | — | run 启动时解析 ResolvedModelAccess |
| credential | 发放可撤销 lease | 每次 provider 请求通过受控 resolver 获取 | secret 不进入 renderer、journal、session ref |
| provider streaming/转换 | — | pi-ai / AgentSession | ModelInvocation 不代理 Agent 主调用 |
| tool schema 与 allowlist | AgentConfiguration + ToolPack | 使用冻结后的有序 schema | run 内顺序/schema 不变 |
| tool loop 与 batch | — | Pi | ToolHost 不排 batch、不安排下一轮 |
| tool 权限与副作用 | ToolHost | 调用 ToolHost callback | fail closed；ledger 与资源锁由 Javdex 持有 |
| retry | 提供 policy 上限、记录事件 | 执行 provider/session/summary retry | Javdex 不 sleep 后调用 continue |
| compaction | Profile 提供预算，记录 normalized result | 执行 threshold/manual/overflow 与 summary retry | 禁止二次 context compression |
| cache policy | ModelPreset/ModelRecord 决定可用策略 | 把 cacheRetention/sessionId 映射到 provider | 每个 role 独立 affinity |
| steer/follow-up/queue | 接受产品命令、记录 ack | 排队、注入和继续运行 | AgentExecution 不维护第二套 queue |
| abort/settled | 发取消请求、投影最终产品状态 | abort 与 agent_settled | 只以 agent_settled 作为 runtime 完全静止信号 |
| dry-run/verify/finish/wait | PluginDeveloperWorkflow | — | 通过 ToolHost 或 tool result 与 Pi 交互 |
| artifact/work log | AgentRunStore + 具体用例 | 提供 runtime observations | UI 只读产品事件，不读 Pi 原始类型 |
| 正常恢复 | 保存 ref、校验 ledger | 打开 Pi session/checkpoint | 同一 checkpoint 继续 |
| 异常恢复 | 提供完整 ExecutionHistory frames | adapter 重建新 Pi session | 仅 corruption/incompatibility；首次 cache miss 正常 |

## 5. Module 与 Interface

### 5.1 PluginDeveloper：具体用例 seam

renderer 和 IPC 继续只依赖 PluginDeveloper，不暴露通用动态 Agent API。它拥有：

- 插件 draft/package revision 与目标站点。
- 初始 dry-run、写后 verify、finish/install gate、wait 与人工反馈规则。
- 插件专用 command、snapshot 和 ProductEvent 类型。
- legacy 或 Pi backend 的迁移选择；这个开关随 legacy 删除而删除。

PluginDeveloperWorkflow 是普通领域 Module，不是可配置 DSL。新增另一类 Agent 时建立另一个具体用例 Module，而不是向 PluginDeveloper 塞条件分支。

### 5.2 AgentExecution：薄编排与投影

AgentExecution 只负责：

- 创建 runId / operationId，幂等接收 start、prompt、steer、follow-up、abort。
- 在 run 启动时冻结 Definition、Profile、ToolPack、routeRevision 与 model access snapshot。
- 每个 run 持有或恢复一个 RuntimeSessionPort handle。
- 把命令直接委托给 RuntimeSessionPort。
- 把 RuntimeObservation 转成 ProductJournal、ExecutionHistory 和用例投影。
- 等待 AgentRunStore/ToolHost 的写入完成后，把 agent_settled 投影为产品 operation settled。
- 在 run close/expire 时 dispose；普通 operation settled 不 dispose。

AgentExecution 禁止：

- 检查 assistant 是否还有 tool call 并决定下一轮。
- 自己调用 provider、转换 Pi messages 或配对 tool result。
- 自己实现 retry、backoff、overflow、summary 或 context window 计算。
- 为每个 operation 调用 open/createAgentSession。
- 在 agent_end 提前结算；只能使用 agent_settled。
- 用 ExecutionHistory 驱动正常 continue。

活动 handle 的最小状态只有：

~~~ts
interface ActiveAgentRun {
  runId: AgentRunId
  runtime: RuntimeSessionPort
  productState: AgentRunProductState
  resolved: ResolvedRunConfiguration
}
~~~

不存在 Javdex 版 AgentState、pendingToolCalls、agentMessages 或 nextTurn。

### 5.3 AgentConfiguration：运行前配置

AgentConfiguration 拥有：

- AgentDefinition：稳定 system prompt、需要的 model roles、ToolPack refs 与具体用例 kind。
- AgentProfile：模型 role 到 route/preset 的绑定、工具授权、审批、预算与 compaction policy。
- 配置引用完整性、revision 与 run-start immutable snapshot。

AgentDefinition 是静态可信记录，不带 prepare/observe/settle 可执行 hook。领域行为留在具体用例。

第一版不做 AgentDefinitionCompiler、动态 schema registry 或运行时热注册。composition root 显式注册 definition 与 ToolPack；保存 Profile 时由 AgentConfiguration 校验引用。

### 5.4 ModelControlPlane：模型控制面

ModelControlPlane 拥有 ModelConnection、ModelRecord、ModelPreset、AIRoute、probe 证据和 ResolvedModelAccess。它负责：

- 配置 CRUD、导入迁移、revision 与引用校验。
- endpoint、proxy、auth、模型能力和 cache compatibility 探测。
- 在 run 启动前解析并固定一条 route；运行中 provider retry 仍由 Pi 完成。
- 发放 main-only、可撤销、短期 CredentialLease。
- 返回 Pi 所需的 model descriptor、compat、fetch/proxy 与 credential resolver。

首版不在 Pi session 创建后自动切换候选模型。创建前解析失败就阻止 run；创建后暂时性失败交给 Pi retry，最终失败形成明确产品错误。未来若开放显式 model switch，必须调用 Pi setModel、保留同一 session，并记录 cache-break marker，不能重建 transcript。

### 5.5 ModelInvocation：仅非 Agent workload

ModelInvocation 服务翻译、结构化 JSON、轻量分类和独立 verifier 等无 tool loop 调用。它可以复用 ModelControlPlane 的 route/proxy/lease/compat，但不得承接 Agent primary streaming。

Agent 主模型链路是：

~~~text
ModelControlPlane.resolveAgentModel()
  -> ResolvedModelAccess
  -> PiRuntimeAdapter
  -> Pi modelRuntime / pi-ai provider
~~~

不存在 ModelInvocation -> Pi -> provider 的双层 Agent streaming。

### 5.6 ToolHost：单次工具调用治理

ToolHost 拥有：

- ToolPack allowlist 与 schema hash 校验。
- capability grant、profile grant 与当前主体授权的交集。
- stable approvalRequestId、canonical args digest、一次性 permit。
- resource lock、AbortSignal、超时、脱敏和 ToolLedger。
- effect 分类：read、write、network、install、credential-sensitive。
- interrupted/uncertain side effect 的人工 reconciliation。

Pi 决定同一个 assistant message 中的工具 batch 与执行模式。首版对写入、审批和终结类工具声明 Pi executionMode 为 sequential；以后只有经并发安全证明的 read-only 工具才允许 parallel。ToolHost 仍按资源加锁，但不重排 Pi batch。

finish/wait 等工具返回 Pi 的 terminate hint，并先写入产品状态。由于 Pi 只有在 batch 中所有结果都 terminating 时才停止自动 follow-up，ToolHost 对 waiting/terminal run 的后续 callback 必须 fail closed；这是状态授权，不是自研 batch scheduler。

### 5.7 AgentRunStore：一个持久化 deep module

物理实现先使用同一套 SQLite/文件事务边界，内部保存：

- AgentRun snapshot 与 runtimeSessionRef。
- ProductJournal。
- ExecutionHistory frames。
- ToolLedger、approval 与 resource lock recovery metadata。
- artifact refs 和工作日志投影。

这些是逻辑记录类型，不拆成 ProductJournalStore、HistoryStore、DiagnosticStore、LedgerStore 四个公共 Interface，也不建设通用 event-sourcing framework。只有发生真实 schema 变化时增加迁移。

## 6. RuntimePort 契约

RuntimePort 的目的只有两个：

1. 把 Pi 类型限制在 adapter 目录；
2. 让 AgentExecution 测试“是否正确委托和投影”，不重测 Pi 算法。

它不是第二个 harness，也不追求运行中 session 的跨 runtime 可移植性。

### 6.1 Interface

~~~ts
type RuntimeCommandKind = "prompt" | "steer" | "follow-up"

interface AgentRuntimePort {
  readonly runtimeId: "pi"

  open(
    input: RuntimeSessionInit,
    observer: RuntimeObserver
  ): Promise<{
    source: "created" | "restored"
    session: RuntimeSessionPort
  }>

  rebuild(
    input: RuntimeSessionInitWithoutResume,
    history: readonly ExecutionHistoryFrame[],
    observer: RuntimeObserver
  ): Promise<RuntimeSessionPort>
}

interface RuntimeSessionPort {
  readonly ref: OpaqueRuntimeSessionRef

  dispatch(command: {
    commandId: AgentOperationId
    kind: RuntimeCommandKind
    content: RuntimeUserContent
  }): Promise<{ accepted: boolean }>

  requestManualCompaction(
    commandId: AgentOperationId,
    instructions?: string
  ): Promise<{ accepted: boolean }>

  abort(reason?: string): Promise<void>
  dispose(): Promise<void>
}

interface RuntimeSessionInit {
  runId: AgentRunId
  resume?: OpaqueRuntimeSessionRef
  model: ResolvedModelAccess
  cache: RuntimeCachePolicy
  systemPrompt: StableSystemPrompt
  tools: readonly HostedToolBinding[]
  settings: PiRuntimeSettingsProjection
}

interface RuntimeObserver {
  notify(event: RuntimeObservation): void
  commit(event: RuntimeDurableObservation): Promise<void>
}
~~~

RuntimeSessionPort 没有以下方法或数据：

- messages、replaceMessages、continue、nextTurn。
- checkpoint、compress、retry、executeToolBatch。
- provider client、raw API request、Pi AgentState。
- canonical history input。

rebuild 是显式异常入口，不是 open 的日常分支。只有 open 返回 checkpoint-corrupt 或 checkpoint-incompatible，且 ToolLedger 没有未对账副作用、ExecutionHistory 完整性校验成功时才可调用。rebuild 的 Pi message 转换只存在于 Pi adapter 内。

### 6.2 command 到 Pi 的一对一映射

| Runtime command | Pi 调用 | Javdex 行为 |
|---|---|---|
| prompt | session.prompt，expandPromptTemplates=false | 记录 accepted；不等待 agent_end 提前结算 |
| steer | session.steer | 不维护自己的 steering queue |
| follow-up | session.followUp | 不维护自己的 follow-up queue |
| manual compaction | session.compact | 只记录请求和结果；不生成 summary |
| abort | Pi clearQueue + abortRetry/abortCompaction/abortBranchSummary + session.abort | adapter 组合 Pi 已有取消入口并等待 durable queue；不自研取消算法 |
| dispose | session.dispose | 只在 run close/expire 或 app shutdown |

Runtime adapter 用 Pi preflightResult 产生 accepted ack；完整运行由 agent_settled 结束。Pi 的 prompt、steer 和 follow-up 队列次序不可由 AgentExecution重新排序。

### 6.3 RuntimeObservation

只投影 UI、审计和恢复真正需要的事件：

~~~ts
type RuntimeObservation =
  | { type: "assistant.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "message.completed"; audit: MessageAuditView; recovery: RuntimeRecoveryFrame }
  | { type: "tool.started"; call: ToolCallAuditView }
  | { type: "tool.progress"; callId: string; summary: string }
  | { type: "tool.completed"; result: ToolResultAuditView; recovery: RuntimeRecoveryFrame }
  | { type: "queue.changed"; steering: number; followUp: number }
  | { type: "retry.changed"; phase: "start" | "end"; attempt: number }
  | { type: "compaction.changed"; phase: "start" | "end"; result?: CompactionAuditView }
  | { type: "usage"; usage: NormalizedModelUsage }
  | { type: "session.saved"; ref: OpaqueRuntimeSessionRef }
  | { type: "agent.settled"; acceptedCommandIds: readonly AgentOperationId[] }
  | { type: "runtime.fault"; category: RuntimeFaultCategory; message: string }

// 同一 union 中除 delta/progress 外、必须进入有序 commit queue 的子集。
type RuntimeDurableObservation = DurableSubset<RuntimeObservation>
~~~

RuntimeRecoveryFrame 是 adapter 生成的版本化 opaque payload；AgentExecution 只验证 hash、加密存储和按顺序交回 adapter，不理解或重排 Pi messages。

### 6.4 durable observation barrier

Pi 0.84.2 的 AgentSession.subscribe 是同步 observer，不能直接 await Javdex 落库。adapter 必须隐藏这个差异：

- text/reasoning delta 走 notify，允许 renderer 丢弃并通过 snapshot 修复。
- completed message、tool result、compaction result、usage、session ref 与 agent_settled 走内部有序 durable queue，再调用 observer.commit。
- custom tool callback 必须先提交 ToolLedger、artifact、模型可见 result 的 recovery frame，再 resolve 给 Pi。
- 可 await 的底层 Agent message/turn listener 用于建立 message boundary；不得把 renderer listener 当 durability barrier。
- session stream wrapper 在每次真正调用 Pi provider stream 前先 drain durable queue，保证 overflow compaction 后的新 summary 已保存，再允许 Pi 发下一次请求。
- dispatch 的 accepted ack 可以立即返回；产品 operation 只有在 Pi 已发 agent_settled 且 durable queue 已排空后才进入 settled。
- adapter 只记录“本次 settled barrier 覆盖了哪些已 accepted commandId”，不复制 Pi queue 内容或决定交付顺序。
- commit 失败时 adapter abort 当前 Pi session 并发 runtime.fault，不能让 Pi 带着未持久化的新上下文继续请求。

这条 barrier 只控制产品记录的提交顺序，不检查 tool call、不选择 next turn、不调用 provider，也不改变 Pi 的 retry/compaction 决策。

### 6.5 Pi adapter 的唯一职责

- 精确 import createAgentSession、SessionManager、SettingsManager、ModelRuntime 与 tool helpers。
- 为 run 创建/打开一条 session 并维持 handle。
- 建立受控 ResourceLoader。
- 为每个 run 建立受控、session-scoped ModelRuntime/credential resolver，只注册已解析模型；不读取 Pi auth.json、models.json、默认目录或 provider credential 环境变量。
- 把 ResolvedModelAccess 适配成 Pi model/auth/fetch；每次请求从 Javdex CredentialLease 取当前 credential。
- 把 HostedToolBinding 包装成 Pi customTools；实际执行回调 ToolHost。
- 注入每个请求的 cache policy 与 affinity。
- 把 Pi event 映射成 RuntimeObservation。
- 编解码异常恢复 frame。
- 维护上述 durable observation queue 和 provider-call 前的 flush gate。

所有 @earendil-works/pi-* import 只能出现在 src/main/agent-runtime/pi/。composition root 只 import createPiRuntimePort。

### 6.6 长期 session 生命周期

~~~text
start run
  -> resolve immutable run configuration
  -> RuntimePort.open(new)
  -> createAgentSession exactly once
  -> save opaque ref

prompt / feedback / steer / follow-up
  -> lookup the same in-memory handle
  -> dispatch to the same Pi AgentSession

renderer reload
  -> handle unchanged
  -> replay ProductJournal snapshot

app restart
  -> RuntimePort.open(resume ref)
  -> SessionManager.open existing Pi session

checkpoint corrupt/incompatible only
  -> validate ToolLedger + ExecutionHistory
  -> RuntimePort.rebuild once
  -> save a new ref and recovery generation
  -> record expected first cache miss

run close/expire
  -> dispose
~~~

## 7. 缓存性能契约

### 7.1 stable affinity ID

每个 runId + modelRole + routeRevision 生成一个稳定、脱敏、最长 64 字符的 ID：

~~~text
cacheAffinityId =
  "jvx_" +
  base64url(HMAC-SHA256(deviceCacheKey,
    "v1" + NUL + runId + NUL + modelRole + NUL + routeRevision))
~~~

SHA-256 的 base64url 输出为 43 字符，加前缀后共 47 字符。ID 不包含原始 runId、用户、endpoint、provider、model 或 secret。deviceCacheKey 存于 Javdex 现有安全凭据设施；密钥轮换会导致预期 cache miss，并写 journal marker。

modelRole 至少包含：

- primary：Pi AgentSession 主循环。
- verifier：插件验证或其他非 Agent ModelInvocation。
- summarizer：Pi compaction/branch summary 请求。

三个 role 必须产生不同 ID。v1 只建立一个 primary Pi AgentSession；verifier/summarizer affinity 不意味着额外创建 AgentSession。

### 7.2 稳定前缀

run 内固定：

- system prompt 内容和 hash。
- ToolPack ref 顺序。
- tool 名称顺序、description、schema、executionMode 与 hash。
- model routeRevision、cache policy 和 role。

ToolPack 解析顺序是 Profile 中 pack 顺序，再按 pack 声明顺序；不得使用对象遍历或 locale sort 产生环境差异。

动态内容不得进入 system prompt：

- 当前 package/draft 内容与 revision。
- 测试目标、站点 URL、用户反馈。
- 时间戳、临时路径、错误详情和上次 dry-run 结果。

这些内容作为首个或后续 user/control message 进入同一 Pi session。prompt template expansion 关闭，避免文件发现改变稳定前缀。

运行中需要修改 system prompt 或 tool schema 时，不热改现有 session；创建新 run。这样既保护缓存，也避免权限语义漂移。

### 7.3 ModelPreset 与 ModelRecord

ModelPreset 新增：

~~~ts
interface ModelPreset {
  // existing inference settings...
  cacheRetention: "none" | "short" | "long"
}
~~~

ModelRecord 保存明确的兼容性，不按 URL 猜测：

~~~ts
interface ModelCacheCompatibility {
  supportsPromptCache: boolean | "unknown"
  supportsLongCacheRetention: boolean
  cacheControlFormat?: "anthropic"
  sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter"
  sendSessionAffinityHeaders: boolean
}
~~~

long 只有 supportsLongCacheRetention 明确为 true 时才允许；unknown 不静默升级。ModelControlPlane probe/人工覆盖都保存 evidence、checkedAt 与 source。

这些字段映射到 Pi 0.84.2 的 StreamOptions.cacheRetention、StreamOptions.sessionId 和 model compat。不得设置进程级 PI_CACHE_RETENTION 来统一控制所有模型。

### 7.4 Pi 0.84.2 的 adapter gap

Pi 0.84.2 的底层 StreamOptions 已支持 cacheRetention 和 sessionId，但 createAgentSession 没有同名顶层参数；默认 Agent 使用 Pi SessionManager 的 sessionId。Pi compaction 还会把 summary 请求设为 cacheRetention=none 并生成随机 sessionId。

因此 Phase 5 必须实现并测试一个局部 cache options bridge：

- createAgentSession 后、首个 prompt 前，包装 Pi 已有 streamFunction；以每个 role 的已验证 product policy 覆盖 sessionId/cacheRetention，再调用原 Pi stream function。
- 正常 Agent 请求使用 primary affinity。
- compaction_start 到 compaction_end 期间使用 summarizer affinity；summary retry 仍留在 Pi。
- verifier 通过 ModelInvocation 使用 verifier affinity。
- bridge 不解析 payload、不发送 HTTP、不实现 retry 或 provider 协议。

若固定 Pi 版本无法可靠区分 summarization purpose，完整 rollout 的门槛是升级到提供 request-purpose hook 的版本或向上游提交最小 hook；不得靠检查 prompt 文本猜测 role。

Pi 0.84.2 的 compaction 使用当前 Agent model 做 summary，没有独立 summarizer model 注入点。配置模型仍保留 summarizer role，但 v1 capability validation 要求它与 primary 解析为同一模型；以后 Pi 暴露 summary-model hook 时再允许不同模型。这个限制留在 adapter capability 中，不删掉长期模型角色。

### 7.5 ProductJournal cache usage

每个完成的模型请求记录：

~~~ts
interface CacheUsageRecord {
  role: ModelRole
  routeRevision: string
  affinityHash: string
  cacheRetention: "none" | "short" | "long"
  cacheRead: number
  cacheWrite: number
  uncachedInput: number
  totalInput: number
  billedCost: number
  missedCost: number | null
  missedCostBasis?: "prior-write" | "stable-prefix-estimate"
  breakReason?: "model-switch" | "compaction" | "ttl-expiry" | "key-rotation" | "runtime-rebuild" | "unknown"
  breakReasonInferred?: boolean
}
~~~

按 Pi usage 口径：

- uncachedInput = usage.input。
- totalInput = usage.input + usage.cacheRead + usage.cacheWrite。
- cacheRead/cacheWrite 与对应 cost 直接使用 Pi 报告。
- missedCost 是反事实估算，不是 provider 真值。没有 prior-write 或 stable-prefix evidence 时记录 null，不能写 0 假装没有损失。
- TTL expiry 通常无法从 provider 直接观察，只能结合最后 cache write 时间与配置推断，必须标记 inferred。

### 7.6 性能评价

主要指标：

1. 每个代表性 run 的总输入成本和总成本。
2. 首 token 延迟、operation settled 延迟的 p50/p95。
3. compaction 前后上下文规模。
4. cacheRead、cacheWrite、uncachedInput 与 missedCost。
5. 任务成功率和工具错误率。

缓存命中率只作为诊断指标。compaction、model switch、TTL expiry 或 runtime rebuild 后的第一次 cache miss 是正常现象，不单独判失败。

## 8. Compaction 单一 owner

AgentProfile 只声明 policy 与预算，例如 enabled、reserveTokens、keepRecentTokens 和允许的 retention；Pi SettingsManager.inMemory 将它投影到单个 session。

Pi 执行：

- threshold 自动 compaction。
- manual compaction。
- context overflow recovery。
- summary 调用和 summary retry。
- 截断点选择与继续运行。

Javdex 只记录：

- compaction start/end、reason。
- Pi 给出的 summary、firstKeptEntry/cut point、tokensBefore 与 usage。
- cache-break marker 和恢复 frame。

禁止：

- 调用 contextCompress 后再把压缩结果交给 Pi。
- 在 AgentExecution 中根据 token 数决定调用 continue。
- Javdex 自己重试 summary。
- 同一 run 同时保留两套 compaction policy owner。

## 9. 持久化与恢复

### 9.1 三种数据，不是三个 runtime

| 数据 | 用途 | 是否活动事实源 |
|---|---|---|
| Pi session/checkpoint | 快速继续、provider cache/session affinity、Pi transcript | 是 |
| ProductJournal | UI 产品状态、artifact、工作日志、cache 指标 | 否；它是产品事实 |
| ExecutionHistory | 审计和 checkpoint 异常时的冷恢复 | 否；正常 turn 永不读取 |

ExecutionHistory frame 同时含：

- 可查询的 normalized audit view。
- adapter 生成、加密保存的 RuntimeRecoveryFrame。
- seq、runtimeId、codecVersion、contentHash 和 retention metadata。

恢复必需内容必须自包含，不能只引用会提前过期的 DiagnosticDetail。大结果可以放加密 blob，但 blob retention 必须至少等于关联 history，完整性校验涵盖所有 reachable blobs。

### 9.2 正常恢复

- renderer reload：main handle 不变，UI 从 ProductJournal snapshot + 增量 cursor 恢复。
- app restart：用 OpaqueRuntimeSessionRef 打开原 Pi SessionManager 文件；不把 History 转回 messages。
- agent_settled：刷新 product projection 与 latest session ref，但不销毁 session。

### 9.3 异常恢复

只有以下 adapter error 允许进入 rebuild：

- checkpoint-corrupt。
- checkpoint-incompatible。
- checkpoint-migration-failed。

顺序：

1. 将 run 标为 recovering，阻止新 command。
2. 检查 ToolLedger 是否有 running/uncertain 写操作；有则先人工对账。
3. 校验所有 ExecutionHistory frame 与 blob 完整。
4. Pi adapter 解码 frame 并创建一个新 Pi session；AgentExecution 不理解消息格式。
5. 新 ref、recoveryGeneration 和 runtime-rebuild/cache-miss marker 原子提交。
6. 用户确认后才发送下一条 prompt；不自动重放工具或最后一条 user command。

History 不完整、codec 不支持或工具副作用不确定时 fail closed，保留只读日志和 artifact，不猜测恢复。

## 10. 模型配置迁移

### 10.1 单一配置 revision，两个 Interface

ModelControlPlane 与 AgentConfiguration 仍是两个 owner，但使用一个 versioned AI configuration repository 的不同 section 和同一 revision。这样 route/profile 的引用更新可以在一笔事务中完成，不再增加公开 ConfigurationMutationCoordinator 或跨 store epoch 协议。

secret 继续独立存于安全凭据设施；config 只保存 credentialRef。

### 10.2 推荐配置形状

~~~ts
interface AIConfigurationDocument {
  revision: string
  modelConnections: ModelConnection[]
  modelRecords: ModelRecord[]
  modelPresets: ModelPreset[]
  routes: AIRoute[]
  agentProfiles: AgentProfile[]
}

interface ResolvedModelAccess {
  model: ResolvedPiModelDescriptor
  routeRevision: string
  preset: ResolvedModelPreset
  cacheCompatibility: ModelCacheCompatibility
  getCredentialLease(): Promise<CredentialLease>
  fetch?: typeof globalThis.fetch
}
~~~

ResolvedModelAccess 是 main-only、短期对象，不持久化 secret，不通过 IPC。Pi adapter 每次请求从 lease 获取有效 credential；撤销立即生效。

### 10.3 UI

模型配置 UI 按以下层级组织：

1. Connection：endpoint、proxy、credential ref 与连通性。
2. Model：API shape、context、tool/vision/reasoning、cache compatibility 与 evidence。
3. Preset：thinking、tokens、timeouts、cacheRetention。
4. Route：用途/role 到 model + preset。
5. Agent Profile：primary/verifier/summarizer route、ToolPack、权限、审批和 compaction policy。

PluginDevPanel 只显示已解析的 profile/route 状态与错误，不再自己推断 provider 默认模型。

## 11. PluginDeveloper 迁移形状

### 11.1 现有规则落点

| 现有行为 | 新 owner | 与 Pi 的交互 |
|---|---|---|
| 创建 draft/package | PluginDeveloper | 动态上下文作为首个 user/control message |
| 初始 dry-run | PluginDeveloperWorkflow -> ToolHost | 结果进入首条 message，不进 system prompt |
| read/write/test 工具 | ToolPack -> ToolHost | Pi custom tool callback |
| 写后 verify | 同一次 ToolHost invocation 的领域后置条件 | 作为 tool result 返回 Pi，不另造 next-turn |
| finish/install gate | PluginDeveloperWorkflow + ToolHost | terminal result + terminate hint |
| wait/人工补充 | PluginDeveloperWorkflow | settled 后用户 prompt/steer/follow-up 复用原 session |
| feedback/debug | PluginDeveloper | session.prompt 到原 session |
| cancel | AgentExecution | session.abort |
| work log/artifact | AgentRunStore | 由 observations 和领域结果投影 |

### 11.2 增加更多 Tool

每个新工具以 ToolPack declaration + ToolHost handler 增加：

- stable name/version/schema/description。
- capability 与 effect。
- approval、resource lock、timeout、redaction。
- executionMode 与 idempotency/reconciliation policy。

不修改 AgentExecution、Pi loop 或 provider adapter。只有模型 API 兼容性发生变化时才改 PiRuntimeAdapter。

### 11.3 增加更多 Agent

一个新 Agent 最少增加：

- 一个具体用例 Interface 和领域 workflow。
- 一个静态 AgentDefinition。
- 一个或多个 AgentProfile 默认值。
- 已有或新增 ToolPack composition。
- ProductEvent projector 与 UI。

它不应新增：

- session manager、retry、compaction、provider、cache 或 tool-batch glue。
- 第二套 AgentExecution。
- Pi 类型泄漏。

第二个真实 Agent 是架构验收项，不要求现在预建通用 workflow DSL。

## 12. 调整后的迁移阶段

### Phase 0：冻结基线与 ownership（1–2 天）

交付：

- 固定 create/debug/feedback/wait/cancel/finish/install/work-log fixtures。
- 记录 legacy 成本、首 token、settled latency、工具错误和包体基线。
- 增加 architecture decision 与禁止职责清单。

门槛：

- 每条插件领域 invariant 有 fixture。
- 明确哪些操作有副作用、可重放、需审批或需锁。

### Phase 1：Electron / Node 基线升级（3–4 天）

交付：

- 升级到内含 Node >=22.19 的 Electron。
- 重建 native dependency，验证 Windows x64/arm64、安装/卸载和自动更新。
- Pi 仍不进入默认启动路径。

门槛：

- 无 Pi 时现有应用、数据库、浏览器、插件与打包测试全过。
- 可以独立回滚。

### Phase 2：建立最小控制面骨架（3–5 天）

交付：

- PluginDeveloper 具体用例 seam。
- 薄 AgentExecution、RuntimePort 类型与 AgentRunStore。
- 静态 AgentDefinition/ToolPack composition。
- 依赖边界测试。

门槛：

- 没有 loop、retry、compaction、provider 或 generic workflow 实现。
- legacy 仍由 PluginDeveloper 直接调用，不实现 RuntimePort。

### Phase 3：模型配置 V2（6–8 天）

交付：

- ModelControlPlane、AgentConfiguration 与单 revision config repository。
- Connection/Model/Preset/Route/Profile 迁移。
- cacheRetention、cache compatibility、probe evidence。
- ResolvedModelAccess、CredentialLease 与非 Agent ModelInvocation。
- 旧配置兼容读取和可回滚写入。

门槛：

- Agent primary 不通过 ModelInvocation。
- renderer 看不到 secret。
- long retention 对 unknown/unsupported model fail closed。

### Phase 4：ToolHost 与插件领域迁移（4–6 天）

交付：

- 18 个现有工具迁入 ToolPack/ToolHost declaration。
- 权限、审批、资源锁、ledger、AbortSignal 与 redaction。
- dry-run、verify、finish、wait 规则从 runner 移到 PluginDeveloperWorkflow。

门槛：

- legacy runner 通过同一 PluginDeveloper/ToolHost 领域 fixture。
- ToolHost 不调度 batch；终结状态后的 callback fail closed。

### Phase 5：Pi Runtime adapter（5–7 天）

交付：

- 精确 pin 0.84.2，lazy import。
- createAgentSession + persistent SessionManager。
- 受控 ResourceLoader：noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles，全关闭。
- noTools=builtin + exact custom ToolPack allowlist。
- 长期 session、prompt/steer/follow-up/abort/manual compact/agent_settled 映射。
- cache options bridge 与三 role affinity contract。
- Pi faux provider contract tests 和少量真实 provider canary。

门槛：

- 同一 run 连续十次 operation 只创建一次 AgentSession。
- Pi built-in/discovery 为零。
- primary/summarizer request purpose 无法可靠区分时停止完整 rollout，不做 prompt 猜测。

### Phase 6：PluginDeveloper Pi backend、恢复与遥测（5–7 天）

交付：

- backend=legacy|pi 的新 run 固定开关。
- ProductJournal/ExecutionHistory/runtime ref 持久化。
- renderer reload、app restart 恢复与 corruption fallback。
- cache/cost/latency/context telemetry。
- PluginDevPanel 使用产品 snapshot/events，不读 Pi。

门槛：

- 18 工具、领域规则、cancel、feedback、wait/resume、work log 全链路通过。
- corrupt checkpoint 只重建一次且不执行任何工具。
- 首次 cache miss after rebuild/compaction 不被当作失败。

### Phase 7：灰度、第二 Agent 与删除 legacy（4–6 天 + 观察期）

交付：

- internal -> opt-in -> beta -> default。
- 用第二个真实 Agent 验证复用。
- 两个稳定版本后删除 legacy runtime 代码和迁移 flag。
- 生产依赖裁剪与 Windows installer 体积复测。

门槛：

- 第二 Agent 不修改 PiRuntimeAdapter 的 session/model/cache/cancel glue。
- 质量不低于 fixture baseline，成本和延迟在 guardrail 内。
- rollback 只影响新 run；已有 Pi run 要么继续原版本，要么只读归档。

## 13. 删除或简化的现有设计

| 原设计 | 处理 | 新形状 |
|---|---|---|
| 通用 Agent platform façade | 删除 | UI/IPC 只调用具体用例 |
| AgentDefinitionCompiler | 删除 | composition root 静态注册 |
| prepare/observe/settle workflow hooks | 删除 | 具体用例 workflow |
| runtime registry/descriptor/feature negotiation | 删除 | 一个精确 pin 的 Pi adapter + 启动 contract check |
| legacy runtime adapter | 删除该方向 | legacy 只在 PluginDeveloper compatibility branch |
| ConfigurationMutationCoordinator | 删除公开 Module | 一个 config document/revision 原子提交 |
| 通用 capability/event schema compiler | 删除 | ToolPack/用例内版本化类型，按需迁移 |
| 四套公开 journal/history/detail/ledger store | 简化 | 一个 AgentRunStore 内部记录 |
| Javdex canonical live transcript | 降级 | ExecutionHistory 只作冷恢复/审计 |
| 每 operation open/checkpoint | 删除 | 每 run 一个长期 Pi AgentSession |
| RuntimePort.checkpoint/messages/continue | 删除 | Pi SessionManager 自动保存；opaque ref |
| 自动跨模型 fallback engine | 删除首版 | run 前解析一条 route；运行后由 Pi retry |
| 自研 approval queue scheduler | 简化 | ToolHost 单次 gate + Pi queue/batch |
| 通用事件 upcaster registry | 删除首版 | 真实 schema 变化时写普通 migration |
| 可热变更 system prompt/tool schema | 删除 | run 内冻结；变化创建新 run |

接入 Pi 且完成观察期后，最终删除以下生产代码：

- 手写 ReAct loop。
- agentMessages。
- contextCompress。
- Agent 专用 provider tool-chat adapters。
- 自研 provider retry、summary retry、compaction 与 overflow recovery。
- 自研 tool-batch/next-turn 编排。
- 任何每轮重建 Pi session 的兼容代码。

删除前允许保留 fixture 和只读历史 migration helper；不允许保留两套活跃实现。

## 14. 风险与缓解

| 风险 | 影响 | 缓解 / stop gate |
|---|---|---|
| Pi 0.x API/session 格式变化 | 恢复或事件映射失效 | 精确 pin；golden session reopen suite；升级独立 PR |
| cacheRetention/role 不是 createAgentSession 一等参数 | 无法满足按模型/role 缓存 | 局部 stream options bridge；无法可靠识别 summary purpose 则停止 rollout |
| 长期 session 泄漏或 stale handle | 内存、错误路由 | run-scoped handle registry、明确 dispose、并发/idle soak test |
| Pi SessionManager 同步 JSONL I/O | 大 session 阻塞 main | 真实长 session 测 p95 event-loop lag；超阈值才评估 worker/sidecar |
| checkpoint 损坏或版本不兼容 | run 无法继续 | golden migration + ExecutionHistory 冷重建；禁止工具重放 |
| provider/cache 兼容标注错误 | 400、成本异常 | capability evidence、long fail closed、真实 endpoint canary |
| provider usage 不完整 | cacheWrite/missedCost 不准 | 标记 source/estimated/null；与账单样本对账，不伪造 0 |
| system/tool drift | cache miss 与权限漂移 | run-start hash、immutable ToolPack、变化新 run |
| parallel tool side effect | 冲突或重复写 | 写/审批/终结工具 sequential + ToolHost locks/ledger |
| approval 期间崩溃 | 状态不确定 | args digest/permit/ledger；恢复前人工 reconciliation |
| credential lease 被撤销 | 活动 run 中断 | 每请求解析 lease；明确 configuration-blocked 产品状态 |
| compaction 摘要丢信息 | 长任务质量下降 | Pi 单 owner；长会话 fixture；记录 summary/cut point/usage |
| ExecutionHistory 含敏感内容 | 数据泄露 | main-only、加密、redaction、retention 与导出审计 |
| Electron/依赖体积 | 安装器增长 | lazy import、裁剪 map/d.ts/docs、最终 installer 实测 |
| vendor lock-in | 切换成本 | Pi 类型 locality + 冷 recovery codec；不伪装运行中零成本替换 |

## 15. 验收门槛

### 15.1 Architecture

- Pi imports 只在 src/main/agent-runtime/pi/。
- renderer/preload/shared 和领域用例的 public types 不含 Pi 类型。
- AgentExecution 无 provider、loop、retry、compaction、message pairing 或 tool batch 实现。
- 生产代码中不存在 AgentDefinitionCompiler、generic workflow DSL 或 legacy RuntimePort adapter。
- 静态检查禁止 AgentExecution import agentMessages、contextCompress、agentToolChatClient。

### 15.2 Session lifecycle

- 新 run 的 createAgentSession 调用次数为 1。
- 同一 run 十次 prompt/steer/follow-up 调用次数仍为 1。
- renderer reload 不创建 session。
- app restart 打开同一 Pi session ref；普通 continue 不读取 ExecutionHistory。
- checkpoint corruption 才调用 rebuild，且每个 recoveryGeneration 至多一次。
- agent_end 不结算；agent_settled 后才投影 settled。
- abort 在 streaming、tool execution、retry backoff、compaction 四个阶段都清除 Pi queue/continuation；返回后没有迟到 provider/tool 调用，durable queue 已排空。

### 15.3 Pi boundary

- ResourceLoader 的 extensions、skills、prompts、themes、context files 均为空。
- built-in tools 为零，只暴露 resolved ToolPack allowlist。
- Pi ModelRuntime 不扫描 catalog/auth 文件，不从 provider API-key 环境变量 fallback；模型与 credential 只能来自 ResolvedModelAccess。
- tool schema/order 在 run 内不变；创建后读取 Pi session 的最终 effective system prompt，必须与 Javdex 预期文本逐字节一致，其 hash 在后续 turn 中保持不变。
- prompt expansion 关闭。
- Pi retry、compaction、overflow、queue、abort 的测试只验证委托和事件映射，不复制算法测试。

### 15.4 ToolHost / domain

- 当前 18 个工具全部通过 schema、permission、abort、redaction 与 ledger fixture。
- 初始 dry-run、写后 verify、finish/install gate、wait/resume 行为与现有产品一致。
- waiting/terminal 后任何 sibling tool callback 都 fail closed。
- corrupt checkpoint rebuild 不重新执行 tool。
- interrupted write 被标为 uncertain，未对账前不能继续。

### 15.5 Model / credential

- 旧模型配置可迁移并可回滚。
- Agent primary 的调用路径不经过 ModelInvocation。
- translation/JSON/verifier 可走 ModelInvocation。
- ResolvedModelAccess/lease 不可序列化到 renderer。
- unsupported long cache retention 在请求前失败，不等 provider 400。

### 15.6 Cache / compaction

- affinity ID 稳定、脱敏、<=64 字符，primary/verifier/summarizer 两两不同。
- 配置只按 ModelPreset/ModelRecord 生效；测试进程没有使用 PI_CACHE_RETENTION。
- 同 provider/model/system/tool hash 的 warm turns 在支持缓存的模型上可观察 cacheRead。
- ProductJournal 同时记录 cacheRead/cacheWrite/uncachedInput/missedCost 与 break marker。
- compaction 后首次 miss 被记录但不判失败。
- 代表性套件的 median 总输入成本不得比 legacy baseline 恶化超过 10%，p95 首 token/settled latency 不得恶化超过 15%；若任务成功率有显著提升，可由产品决策显式接受例外。
- 任何命中率提升都不能以任务成功率、审批正确性或 tool error 恶化为代价。

### 15.7 Recovery / rollout

- 至少覆盖正常关闭、renderer reload、app restart、checkpoint corruption、tool interrupted 五种 fixture。
- History/associated blob 完整性损坏时 fail closed。
- Pi 升级 PR 对真实脱敏 session 样本做 open/continue/compaction 测试。
- 第二 Agent 只新增具体用例、definition/profile、ToolPack composition 和 UI projector。
- legacy 删除后 rg 不再命中手写 loop、agentMessages、contextCompress、Agent provider tool-chat adapter 的生产引用。

## 16. PR 切分

建议保持每个 PR 可独立回滚：

1. ADR + ownership/static dependency tests。
2. Electron/Node 升级。
3. PluginDeveloper seam + AgentExecution/RuntimePort skeleton。
4. AgentRunStore schema。
5. ModelControlPlane/AgentConfiguration V2 与配置迁移。
6. ResolvedModelAccess/CredentialLease/ModelInvocation。
7. ToolPack/ToolHost + 插件领域规则迁移。
8. Pi dependency pin + controlled ResourceLoader + session lifecycle。
9. cache options bridge + usage telemetry。
10. PluginDeveloper Pi backend 与 UI product event migration。
11. recovery/golden sessions/Windows packaging。
12. 第二 Agent proof。
13. 默认切换；观察期后删除 legacy。

## 17. 估算

| 阶段 | 工程日 |
|---|---:|
| Phase 0 基线与 ownership | 1–2 |
| Phase 1 Electron/Node | 3–4 |
| Phase 2 最小控制面 | 3–5 |
| Phase 3 模型配置 V2 | 6–8 |
| Phase 4 ToolHost/领域迁移 | 4–6 |
| Phase 5 Pi adapter | 5–7 |
| Phase 6 插件 Pi backend/恢复/遥测 | 5–7 |
| Phase 7 第二 Agent/灰度/清理 | 4–6 |
| **合计** | **31–45** |

相对旧计划的 43–62 工程日，减少约 12–17 天，主要来自删除 compiler/DSL、runtime registry、跨 store coordinator、通用 event-sourcing/upcaster、第二套 live transcript、每轮 session rebuild 与自研 retry/compaction。

估算不包含：

- Pi 上游必须增加 request-purpose/cache hook 时的等待时间；本地最小适配预计另加 1–3 天。
- 两个稳定版本的生产观察期。
- 与本任务无关的插件 UI 重新设计。

## 18. 上游事实依据

- Pi SDK 的 createAgentSession、prompt/steer/followUp、abort、SessionManager 与 custom tools：[SDK 文档](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md)
- AgentSession 0.84.2 包含 agent_settled、queue、compaction 与 retry events：[AgentSession source](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts)
- pi-ai StreamOptions 支持 cacheRetention 和 sessionId，Usage 含 cacheRead/cacheWrite：[pi-ai types](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/types.ts)
- ResourceLoader 可关闭 extensions/skills/prompts/themes/context discovery 并固定 system prompt：[ResourceLoader source](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/resource-loader.ts)
- Pi compaction 自己执行 summary/retry，并在 0.84.2 默认把 summary cache retention 设为 none：[Compaction source](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/compaction/compaction.ts)
- working integration 使用 createAgentSession，不使用尚未作为本方案基础的 AgentHarness。
