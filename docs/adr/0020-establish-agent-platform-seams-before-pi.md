# ADR-0020：采用 Javdex 产品控制面 + Pi Agent 数据面

- 状态：Accepted
- 日期：2026-08-20

## 背景

当前插件开发 Agent 把模型选择、手写 ReAct loop、provider tool-chat、contextCompress、工具执行、插件领域规则、工作日志和 IPC 生命周期耦合在 pluginDevAgent 中。

最初计划在 Pi 外建立一套通用 Agent 平台，包括 runtime compiler、canonical transcript、checkpoint protocol、workflow hooks、retry/compaction 编排和通用事件体系。这会重复 Pi 已经提供的 AgentSession、tool loop、provider conversion、queue、retry、compaction 与 SessionManager，形成第二个 runtime。

产品仍需要由 Javdex 掌握身份、授权、领域完成条件和可见记录；未来也需要增加更多 Agent 和工具。因此需要一个能扩展产品能力、但不复制 Agent 数据面的边界。

## 决策

### 1. 划分控制面与数据面

Javdex 是产品控制面，拥有：

- Agent runId、operationId、产品状态和持久化。
- ModelControlPlane、AgentConfiguration、route、credential lease 与 capability validation。
- ToolHost、权限、审批、资源锁、副作用 ledger 和脱敏。
- PluginDeveloper 的 dry-run、verify、finish、wait、install 等领域规则。
- ProductJournal、ExecutionHistory、artifact 与工作日志。

Pi 是 Agent 数据面，独占：

- LLM streaming、provider 协议与跨 provider 消息转换。
- tool-calling loop、工具 batch、下一次模型调用。
- retry、compaction、overflow recovery 与 summary retry。
- runtime transcript、tool-call/result pairing。
- prompt cache/session affinity 的实际 provider 映射。
- steer、follow-up、queue、abort、AgentSession 与 agent_settled。

### 2. 一个 run 长期复用一个 Pi AgentSession

每个 Javdex Agent run 在 v1 只有一个 primary Pi AgentSession。普通 prompt、continue、steer、follow-up、等待后的恢复和人工反馈都使用原 session。

operation settled 不销毁 session。只有 run close/expire、应用退出或不可恢复错误才 dispose。

renderer reload 不影响 main 中的 session。应用重启优先用保存的 opaque ref 打开同一个 Pi SessionManager session。

### 3. AgentExecution 是薄编排 Module

AgentExecution 只：

- 接收并幂等记录产品 command。
- 在 run 开始时冻结 definition/profile/tool/model snapshot。
- 找到同一个 RuntimeSessionPort 并委托 command。
- 把 RuntimeObservation 投影到 Javdex 产品状态和记录。
- 在 Pi agent_settled 且 durable observation queue 已排空后结算 product operation。

AgentExecution 不：

- 实现模型/tool loop 或 next-turn scheduling。
- 转换、排序或配对 Pi messages。
- 实现 provider/session/summary retry。
- 实现 compaction、overflow recovery 或 summary。
- 为每个 operation 重建 Pi session。

### 4. 保留一个薄 RuntimePort

RuntimePort 只隔离第三方类型和支持 adapter wiring 测试。它表达：

- create/restore 一个长期 session。
- prompt、steer、follow-up。
- 委托 Pi manual compaction。
- 组合 Pi 已有取消入口并 abort。
- dispose 与 normalized observations。
- checkpoint 损坏/不兼容时的一次性冷 rebuild。

它不暴露 messages、continue、checkpoint、retry、tool batch 或 provider client。运行中的 Pi session 不承诺迁移到其他 runtime。

所有 Pi import 只允许出现在 main 的 Pi adapter 目录。legacy runner 不实现 RuntimePort，只留在 PluginDeveloper 的迁移分支。

### 5. Pi session/checkpoint 是首选 runtime state

Pi AgentSession/SessionManager 是活动 transcript 与性能路径。Javdex ExecutionHistory 只保存：

- normalized audit view。
- Pi adapter 生成的加密、版本化 RuntimeRecoveryFrame。

正常 operation 永不读取 ExecutionHistory。只有 checkpoint-corrupt、checkpoint-incompatible 或 migration failure 才允许 adapter 从完整 History 重建一次。重建不执行工具、不重放最后一条 command，并接受下一次请求 cache miss。

### 6. ToolHost 只治理单次调用

Pi 决定工具 batch、顺序和 follow-up。ToolHost 对每个 callback 做 allowlist、授权、审批、lock、ledger、redaction 与 effect execution。

写入、审批和终结类工具在 Pi 声明为 sequential；安全只读工具经证明后才可 parallel。waiting/terminal 状态后的 sibling callback fail closed。

dry-run、verify、finish、wait 是 PluginDeveloperWorkflow 的领域规则，不进入通用 workflow DSL。

### 7. Agent 主模型直接交给 Pi

ModelControlPlane 解析 ResolvedModelAccess，包含 model descriptor、compat、proxy/fetch 和可撤销 credential lease。Pi adapter 直接把它交给 Pi model runtime。

ModelInvocation 仅用于非 Agent 翻译、JSON、分类、独立 verifier 等调用。它不代理 Agent 主 streaming，也不实现第二套 provider/tool-chat。

### 8. 缓存契约按 run、role 与 route version 固定

每个 runId + modelRole + routeRevision 使用稳定、脱敏、最长 64 字符的 HMAC affinity ID。primary、verifier、summarizer 使用不同 ID。

run 内 system prompt、ToolPack 顺序和 tool schema 固定。package、测试目标、时间戳等动态内容进入后续 user/control message。

ModelPreset 保存 cacheRetention = none | short | long。ModelRecord 显式保存 supportsLongCacheRetention、cacheControlFormat、sessionAffinityFormat 与 sendSessionAffinityHeaders；不使用全局 PI_CACHE_RETENTION 统一控制所有模型。

ProductJournal 记录 cacheRead、cacheWrite、uncachedInput、missedCost，并标记 model switch、compaction、TTL expiry、key rotation 与 runtime rebuild。missedCost 是可空的反事实估算，不能冒充 provider 真值。

### 9. Compaction 只有 Pi 一个 owner

AgentProfile 只提供 compaction policy 和预算。Pi 执行自动/手动 compaction、overflow recovery、summary 与 summary retry。

Javdex 只记录 normalized event、summary、cut point 和 usage。禁止先用 contextCompress 压缩后再交给 Pi。

### 10. 配置和扩展保持具体

ModelControlPlane 与 AgentConfiguration 是两个 Interface，但首版共享一个 versioned AI configuration repository 和 revision，避免额外 ConfigurationMutationCoordinator。

AgentDefinition 与 ToolPack 在 composition root 静态注册，不建立 compiler、动态 registry 或 workflow DSL。

新增 Agent 时增加具体用例、definition/profile、ToolPack composition 和 UI projector；不增加 session/provider/retry/compaction glue。

## 结果

正面结果：

- 直接使用 Pi 成熟的 AgentSession 能力，不重复 runtime。
- Javdex 仍控制产品状态、模型治理、工具安全和领域完成条件。
- 长期 session 与稳定 cache prefix 提供更好的延迟和成本路径。
- Pi 类型和变动局限在一个 adapter Module。
- 新 Agent/Tool 的扩展点清晰。

代价与限制：

- 对 Pi 0.x 和 session 格式存在有意识的依赖，需要精确 pin 与 golden-session upgrade tests。
- RuntimePort 不提供运行中跨 runtime 可移植性。
- ExecutionHistory 冷恢复需要额外存储、加密和 codec 测试，但不能变成第二个 live transcript。
- Pi 0.84.2 没有 createAgentSession 级 cache options，且 summary 默认禁用 cache；需要 adapter 内的局部 stream-options bridge，或升级到带 request-purpose hook 的版本。
- Pi 0.84.2 的 compaction summary 使用 primary model；配置可保留 summarizer role，但 v1 必须解析到同一模型，直到上游提供独立 summary-model hook。
- AgentSession 的部分观察回调不可 await，adapter 必须维护 durable observation queue，并在下一次 provider call 前 flush；这只是提交屏障，不是 next-turn scheduler。

## 被否决或删除的设计

- 在 Pi 外再建通用 Agent runtime/harness。
- AgentDefinitionCompiler、prepare/observe/settle hooks 与 workflow DSL。
- Javdex canonical live transcript 和每 operation session rebuild。
- RuntimePort 的 checkpoint/messages/continue/retry/compaction API。
- 通用 runtime registry 与运行中零成本替换承诺。
- Agent 专用 ModelInvocation/provider tool-chat。
- Javdex 自研 ReAct loop、agentMessages、contextCompress、retry、compaction 和 tool-batch orchestration。
- 让 legacy runner 实现通用 RuntimePort。

## 后续

具体迁移阶段、Interface、缓存指标、风险、验收与工期见 [Agent 控制面与 Pi 数据面接入执行计划](../AGENT_PLATFORM_EXECUTION_PLAN.md)。
