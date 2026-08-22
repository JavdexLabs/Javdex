# ADR-0022：模型管理 v3 以用途绑定为唯一配置源

- 状态：Accepted
- 日期：2026-08-22
- 替代：ADR-0020 中面向用户的 ModelPreset、AIRoute 与 AgentProfile 配置方案

## 背景

旧模型设置同时暴露默认 LLM、提供商、模型、Preset、Route、Agent Profile、三个模型 role、
ToolPack、权限和审批。相同意图分散在 `settings.json` 与 `ai-configuration.json`，保存提供商还会
通过兼容同步改写 Agent 绑定。用户很难判断哪一层最终生效，运行时代码也存在从实时设置重新
解析模型的机会。

## 决策

### 1. 一个持久配置源

`ai-configuration.json` schema v3 是连接、生成模型目录和用途绑定的唯一配置源。公开领域只有：

- 提供商连接；
- 生成模型及其 baseline / 人工覆盖能力；
- `app-default`、`plugin-developer`、`library-curator` 三个用途。

应用默认用途必须显式选择模型。两个 Agent 用途可以继承默认模型或独立指定，并各自保存
thinking、最大输出、超时、缓存、compaction、最大轮次和最大上下文。有效模型元数据只由
`ModelManagementModule` 合并；Renderer 与调用方不得自行合并 baseline 和 override。

### 2. 深 Module 与命令边界

`ModelManagementModule` 只公开 `read`、`apply`、`discoverModels`、`testModel` 和 `resolve`。
原子文件、凭据保险库和提供商传输是内部 Adapter。变更使用带 `expectedRevision` 的单命令，
revision 不匹配时配置与凭据都不写；凭据先写、配置失败时补偿恢复。发现结果只有用户明确添加
后才进入目录。

### 3. 代码拥有 Agent 策略

Agent Definition、ToolPack、capability grants 和审批策略继续由代码维护，不进入模型文档或模型
设置页。AgentConfiguration 只把当前用途的 compaction 投影进兼容的冻结 `AgentProfile` 形状。
PluginDeveloper 与 LibraryCurator 的 primary / summarizer 使用同一个用途模型；正常路径不解析
独立 verifier 模型。

### 4. 冻结与兼容

新任务从最新 document revision 解析一次模型访问并写入 run configuration snapshot。活动任务和
恢复任务始终使用该冻结快照；设置变更只影响新任务。历史 `ModelRole`、AgentProfile 和冻结模型
结构仅为运行历史兼容保留，不再是用户配置概念。

schema v2 首次读取时与 `settings.json` 的旧非密钥 LLM 字段合并迁移，并在非覆盖备份后写 v3。
损坏的 v3 fail closed。旧 AppSettings 字段只作为迁移输入：不进入 Renderer snapshot、不接受
Renderer 更新、不被运行时读取，也不由 v3 Module 回写。

### 5. 用户界面

模型设置只展示“用途与运行”“提供商与模型”“高级”三个页签。表单必须显式保存；提供商详情
统一处理连接、凭据、模型发现、测试和目录变更。高级页默认只显示三个用途实际引用的模型。
界面不再出现 Route、Preset、Profile、ToolPack、grants 或 verifier 配置。

## 后果

模型选择和运行参数有了唯一所有者，提供商维护不会暗改用途；每个 run 的实际模型可被准确
展示和审计。代价是高级用户不能再直接编辑 Route/Preset/Profile 图结构；需要新增用途时必须
先在代码中定义其策略并扩展明确的 `ModelWorkloadId`，而不是创建任意路由。
