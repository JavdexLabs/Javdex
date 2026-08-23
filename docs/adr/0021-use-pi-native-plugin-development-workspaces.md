# ADR-0021：插件开发采用 Pi 原生工作区与轻宿主

- 状态：Accepted
- 日期：2026-08-21
- 修订：2026-08-23
- 替代：ADR-0020 中与 PluginDeveloper 领域工具、语义验证和完成门禁有关的实现决策

## 背景

实际回放表明，同一模型使用直接 Pi、浏览器 Skill 和插件规范时，可以快速完成结构简单的站点；旧应用内流程却因为低层浏览工具、重复提示、宿主页面解析、语义 verifier 和自动修复门禁不断重做。宿主事实上成为拥有最终否决权的第二个 Agent。

## 决策

### 1. Pi 拥有开发与语义判断

每个 PluginDeveloper run 使用独立工作区。Pi 通过原生 `read/write/edit/grep/find/ls` 修改 `plugin.json`、`index.js` 和 `.javdex/dev-notes.md`，并使用冻结的 `javdex-plugin-dev` 与 `javdex-browser-operation` Skills 完成：

- 页面探索和精确目标判断；
- 字段映射和选择器设计；
- 结果内容正确性判断；
- `supportedFields` 完整性维护；
- 以 dev-notes 为外部记忆的自适应实现—运行循环。

宿主不解析 browser observation、页面标题、JSON-LD 或 artifact 来证明目标身份，也不生成字段语义 blocking issue。插件代码是站点行为的最终来源。

### 2. 只加载受控资源

工作区的 Skills、任务和规范由 Javdex 生成并按 SHA-256 冻结。Pi 不发现用户全局资源、仓库父目录资源或未审核 package。首期不启用 `bash`；原生写工具只能修改两个草稿文件与 `.javdex/dev-notes.md`，并拒绝 realpath/symlink 逃逸。`.javdex/latest-dry-run.json` 由宿主创建为 schema v2 的 `not_run`，真实执行后原子保存 `completed` 事实；独立的 `currentAcceptance` 投影在包、目标、runtime 或工作区有效性变化时同步更新。Pi 只读，正常 dry-run 后直接使用工具结果，只在恢复时读取该文件；两种开发记忆文件都不进入插件包或 artifact hash。

### 3. 浏览器是环境，不是裁判

独立 Electron scraper helper 提供 Playwright ARIA、ref、find、自动等待和完整 artifact。高密度 observation 交给 Pi；省略分区通过 `PluginBrowserCapabilityModule.readSection` 的有界页面和不透明 cursor 读取，索引与分片格式不暴露给 Pi，也不获取浏览器租约。`browser` schema 按 action 区分必需和允许参数，避免让模型从一组平铺可选字段猜调用合同。页面文本、ARIA、HTML、脚本和网络响应均视为不可信站点数据，不能成为 Agent 指令。宿主最终验收不消费 artifact。浏览器共用生产 profile 与独占租约，busy 立即失败，不排队或自动重试。

### 4. 明确的沙箱运行目标

Agent dry-run 只接受：

```ts
type PluginDevRunTarget =
  | { kind: 'video'; code: string }
  | { kind: 'actress'; mainName: string; aliases: string[] }
```

URL、路径和控制字符在工具边界被拒绝。这是输入类型保护，不是网页语义认证。首次合法显式目标成为会话完整目标集；之后显式目标若与当前完整目标集指纹相同则仍按完整验收运行，真子集才作局部诊断，省略参数运行全部目标。若最近一次完整执行对当前目标全部是未找到精确匹配的空结果，下一次合法显式目标替换会话目标集；空结果本身不能通过安装门禁。

### 5. 一个生产执行 Module

`PluginExecutionModule.run` 是 PluginDeveloper 唯一运行入口。它调用正式沙箱，并记录：

- `pluginResult`：基础规范化后的插件返回；
- `effectiveResult`：正式运行时按 manifest 投影后真正可用的返回；
- 字段级 `manifestCoverage`、日志、错误和 `runtimeAccepted`；
- 包、目标、scope 和 runtime 的稳定指纹。

`manifestCoverage` 由唯一的机器可读结果契约生成，只包含当前 kind 的合法字段 id；身份和调试键单独列为 `runtimeOnlyKeys`。它不分类网页语义问题，也不修改代码或 manifest。完整 artifact 写入工作区 report，紧凑事实直接返回 Pi。普通刮削与非 Agent dry-run 继续通过 Adapter 使用原有字符串入口。

### 6. 最终门禁只证明能运行

删除 `PluginCheckModule`、`PluginArtifactGate` 和隐藏机械修复 continuation。唯一最终门禁 `PluginRunAcceptanceModule` 只接受与当前包、全部目标和 `runtime-v2` 精确匹配的完整生产执行，并要求每个目标都有至少一个含实际值的可声明生产字段。

它不判断内容值、页面匹配、字段来源、未实现字段或 `supportedFields` 完整性。Pi 必须显式执行最后一次完整 dry-run；自然停止不会触发隐藏运行。`agent.settled` 只结束当前模型 operation：机械 artifact 缺失或过期时进入 `waiting_user/working`，通过时进入 `waiting_user/ready`。两种状态都可继续 Agent，只有 ready 状态可安装；安装写盘成功后才把会话投影为 `completed`。

### 7. 自适应开发循环

`plugin_dry_run` 不设领域次数上限。Pi 在首次精确详情页后把已观察字段、当前实现和明确未完成项记录到 dev-notes。证据充分的简单网站可以在一个连贯修改中实现全部明确字段并运行一次；只有复杂实现、具体不确定性或真实 dry-run 问题存在时，才继续 `write/edit ↔ plugin_dry_run`。浏览同样按证据自适应：每次处理一个具体 blocker，新证据暴露新 blocker 时可继续，不用任意总次数上限；没有新事实、`unchanged` 或只剩理论问题时停止。多轮是解决真实缺口的能力，不是必须经历的状态机。

这些规则只由 `javdex-plugin-dev` Skill 持有，并组织为“启动或恢复、获取证据、实现、运行与结束”四个阶段。initial message 和各类 continuation 只描述本次事件变化并指回适用阶段，避免形成与主 Skill 漂移的第二套流程。choice 决定持久化原问题、完整所选项和证据引用，恢复时重新评估 blocker，不把一次决定硬编码为探索结束或必然 dry-run。恢复、继续或上下文压缩后先读取 dev-notes、当前代码、manifest 和最新 dry-run 小文件，避免重新浏览或通读大型证据。通用模型轮次上限由用户配置，`0` 表示不限制且为默认值；取消、工具超时和浏览器租约仍负责资源保护。

### 8. 状态与升级

- task schema v3 / instruction set v26；
- ToolPack `toolpack:plugin-developer:v13`；
- product state 与工作日志新写 schema v7，schema v6 终态历史只读导出；
- runtime acceptance `runtime-v2`；
- 数据库 v22 关闭未结束的 PluginDeveloper v8 run，并拒绝其未决请求/许可；v23 删除已失去运行时消费者的旧站点字段映射表；v24 关闭未结束的 v9 run；v25 关闭未结束的 v10 run；v26 关闭未结束的 v11 run；v27 关闭未结束的 v12 run，并拒绝其未决请求/许可。

工作区草稿、当前编辑器代码、已安装插件和其他 Agent 会话不受影响。

## 深 Module

| Module | 外部 Interface | 隐藏实现 |
|---|---|---|
| `PluginWorkspaceModule` | open/snapshot/updateRunTargets/recordLatestDryRun/updateCurrentAcceptance | 原子文件写入、资源冻结、草稿与 dev-notes 恢复、执行事实与当前验收投影持久化 |
| `PluginExecutionModule` | run | 沙箱、正式结果规范化/投影、报告 |
| `PluginResultContractModule` | describe/analyze | 按 kind 的标准结果键、字段级 coverage、有效值判断 |
| `PluginRunAcceptanceModule` | evaluate | runtime/包/目标/scope 精确门禁 |
| `PluginBrowserCapabilityModule` | execute/readSection | helper、ARIA、artifact 存储、完整性与有界分区分页 |
| `PiRuntimeAdapter` | RuntimePort | 原生文件 capability、tool loop、compaction |

## 后果

正面结果是 PluginDeveloper 更接近直接 Pi 的信息密度和行动方式；错误的宿主语义规则不再破坏正确代码，测试工具也不再分叉。代价是宿主有意不保证插件内容在业务语义上正确；质量依赖 Skill、Pi 对真实结果的判断和用户最终选择。宿主只保证已安装 artifact 能按生产运行时执行并返回有效结果。
