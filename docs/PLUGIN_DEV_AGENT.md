# 插件开发助手（PluginDeveloper v13）

PluginDeveloper 采用“Pi 主导、宿主轻量”的自适应开发架构。Pi 与冻结的 Skills 负责浏览、外部开发笔记、字段范围、代码实现和结果语义判断；Javdex 只提供隔离工作区、浏览器、生产沙箱、最新运行事实和安装机械门禁。简单网站可以一次实现并验证，只有真实缺口才进入多轮迭代。

## 职责边界

Pi 负责：

- 找到代表性的精确详情页，并从页面提取真正的影片番号或演员主名/别名；
- 根据页面事实判断字段含义、选择器和返回值是否正确；
- 把当前页全部已明确字段写入 `.javdex/dev-notes.md`，根据当前证据一次或按需分批实现，并维护 `plugin.json.supportedFields`；
- 比较 `pluginResult`、`effectiveResult` 和 `manifestCoverage`；
- 在证据充分时直接实现并 dry-run；只有明确错误或未完成字段存在时才使用 `write/edit ↔ plugin_dry_run` 继续迭代。

宿主不再解析 ARIA、JSON-LD、页面标题或 browser artifact 来认证目标，也不判断字段值是否可信、页面是否还有字段、`sourceUrl` 是否为浏览过的页面，或 `supportedFields` 是否完整。宿主不会自动修改 manifest 或向 Pi 发送隐藏修复轮次。

宿主只负责：

- 约束可写文件并维护工作区；
- 提供独立 Electron scraper helper 和生产插件沙箱；
- 校验工具输入类型，拒绝把 URL、路径或控制字符当作番号/演员名；
- 返回插件原始结果和生产投影结果；
- 原子保存最新一次真实执行事实；
- 安装前确认当前包已对全部会话目标在当前生产运行时成功执行。

## 工作区与指令

工作区的 `plugin.json` 和 `index.js` 是插件草稿的唯一真相，`.javdex/dev-notes.md` 是 Pi 的外部开发记忆。Pi 可使用受控的 `read`、`write`、`edit`、`grep`、`find`、`ls`，但只能修改这三个文件。宿主生成并冻结其他资源：

```text
task.json                         # schema v3；站点、模式、kind、runTargets、用户要求
docs/plugin-format.md             # 精确沙箱输入和返回契约
docs/fields-video.md              # 影片字段查询表
docs/fields-actress.md            # 演员字段查询表
.agents/skills/javdex-plugin-dev/SKILL.md
.agents/skills/javdex-browser-operation/SKILL.md
.javdex/dev-notes.md              # Pi 可写；页面事实、字段覆盖和明确未完成项，不进入插件包
.javdex/latest-dry-run.json        # schema v2；最近执行事实 + 当前机械验收投影，宿主只写
.javdex/browser/*.json            # 仅供 Pi 阅读和日志导出
.javdex/reports/*.json            # 完整生产执行 artifact
```

新工作区使用 `instructionSetVersion: 26`。system prompt 只声明身份、文件边界、恢复入口和 Skill 所有权；完整开发循环只存在于按当前 kind 生成的 `javdex-plugin-dev` Skill，并按“启动或恢复 → 获取证据 → 实现 → 运行与结束”四个阶段组织。initial message 和 continuation 只传递本次事件事实与适用阶段，不再复制文件读取、停止条件或验收分支。create 首次实现前读取一次当前 kind 的 `docs/plugin-format.md` 作为唯一沙箱输入、返回形状和候选处理契约，并在首次浏览前读取 `javdex-browser-operation`；debug 或恢复仅在修改涉及这些契约或 notes 明确缺少契约事实时重读。create/debug 都只创建空 notes 模板，宿主不从页面或 manifest 推断字段范围。工作区刷新会保留 `plugin.json`、`index.js`、decisions 和 dev-notes。choice 决定在 `.javdex/decisions.json` 中保存原问题、所选项 id/label/description 和关联 evidenceRefs；恢复提示会重新评估当前 blocker，不假定一次选择自动结束全部歧义或必然需要修改、dry-run。

暂时无法解析的 `plugin.json`/`index.js` 只令工作区进入可恢复的 `WORKSPACE_INVALID`，不会把整个 Agent run 标为失败。文件修复后自动重新同步；无效期间调用 dry-run 不执行沙箱，也不覆盖最近执行事实，只把 `currentAcceptance` 更新为不可安装及 `workspace_invalid`。

## 运行目标

会话使用明确的领域目标：

```ts
type PluginDevRunTarget =
  | { kind: 'video'; code: string }
  | { kind: 'actress'; mainName: string; aliases: string[] }
```

它只表示真正传入生产沙箱的输入，不保存页面 URL、browser artifact 或发现证据。`task.json.runTargets` 为空时，Pi 先浏览站点：影片提取真正番号，演员提取主名和明确别名。页面 URL 只能用于理解网站和编写插件，不能作为 dry-run 目标。

第一次合法的显式目标会被采纳为会话完整目标集，并立即持久化、发出 `run_targets_updated`，让 UI 目标框即时刷新。会话已有目标后，显式参数若与当前完整目标集指纹相同则仍按 `scope=all` 验收；真子集才作局部诊断。省略参数运行全部会话目标。例外：最近一次完整执行对当前会话目标全部是「未找到精确匹配」的空结果时，下一次合法显式目标会替换会话目标集并按 `scope=all` 验收。空结果本身不能 `installReady`。

## Agent 可见工具

ToolPack `toolpack:plugin-developer:v13` 只有三个自定义工具：

| 工具 | 用途 |
|---|---|
| `plugin_dry_run` | 在生产沙箱执行当前工作区插件，返回真实结果和生产投影事实 |
| `browser` | `open/snapshot/find/html/evaluate/click/fill/press/wait/status/read-section/handoff`；artifact 分区读取不获取浏览器租约 |
| `ask_user` | 创建绑定 requestId 的 choice/freeform 请求 |

`browser` 的输入使用按 action 区分的 schema：例如 `open` 必须有 `url`，`click` 必须有 `target`，`fill` 必须有 `target/text`，`read-section` 必须有 `artifactRef/section`，`handoff` 必须有 `reason`；各分支拒绝其他 action 的参数。

不存在 Agent 可见的 `plugin_check`、`plugin_test`、完成或安装工具。外部 MCP server 暴露同一组 v13 工具。

页面内可安全关闭的成人确认、广告、介绍或 Cookie 遮挡由 Pi 读取可见控件后按页面规则关闭，每个遮挡层最多尝试一次。登录弹窗存在关闭、跳过或访客入口时同样直接关闭；确实需要登录、人机验证或其他必须由用户亲自完成的浏览器动作时，Pi 调用 `browser(action="handoff", reason=...)`。宿主只负责显示并聚焦 helper、创建绑定 requestId 的 `browser_interaction` 请求和保持浏览器租约，不判断页面弹窗语义，也不接收账号、密码或验证码。开发助手打开的 helper 窗口在回合结束后保持，不因空闲超时关闭；离开开发页或会话终态时关闭。正式刮削从拿到浏览器租约起显示 helper，任务结束后立即关闭。

### `plugin_dry_run` 输入

影片：

```json
{ "videoCodes": ["YST-222"] }
```

`YST-222` 只演示参数格式；实际值必须来自本次精确详情页，不是固定测试目标。

演员：

```json
{
  "actresses": [
    { "mainName": "三上悠亜", "aliases": ["Yua Mikami"] }
  ]
}
```

`三上悠亜` 也只演示参数格式；实际主名和别名必须来自本次精确资料页。

video 会话只接受 `videoCodes`，actress 会话只接受 `actresses`，单次最多 8 个目标。空值、URL scheme、明显路径和控制字符返回 `RUN_TARGET_INVALID`；不会写入会话、执行沙箱或覆盖最新运行事实。

省略参数时运行全部会话目标。首次无目标会话的合法显式参数会成为完整目标集；已有目标后，显式参数与当前完整目标集指纹相同则仍是完整验收，真子集才是 `targeted` 诊断，不能取得安装资格。例外是当前会话目标的最近一次完整执行为空结果（未找到精确匹配）时，下一次合法显式参数会替换目标集并按完整验收运行。`scope=targeted` 的 `installReady=false` 只表示这次不是完整验收，不是运行失败；宿主不会把普通真子集 targeted 自动改写成 `all`，也不会在模型停止后隐藏再跑一次。

### 运行结果

每个 case 返回：

- `runtimeInput`：本次真正传入沙箱的 `code` 或 `mainName/aliases`；
- `pluginResult`：插件函数经过基础规范化后的输出；
- `effectiveResult`：应用生产运行时按 `supportedFields` 投影后真正可用的输出；
- `unrecognizedResultKeys`：规范化前的原始返回中，不属于当前 kind 结果契约的键名；只报告名称，不猜测映射或返回修复建议；
- `manifestCoverage.returnedFieldIds`：插件实际返回的合法字段 id；
- `manifestCoverage.undeclaredReturnedFieldIds`：插件已返回、但 manifest 尚未声明的合法字段 id；
- `manifestCoverage.runtimeOnlyKeys`：身份或调试信息，不属于 `supportedFields`；
- 末尾日志、错误和 `runtimeAccepted`。

`undeclaredReturnedFieldIds` 是唯一可直接写入 manifest 的机械建议。`runtimeOnlyKeys` 只作中性说明：演员 `mainName` 是运行身份，`sourceUrl` 是可选调试来源，二者都不能加入 `supportedFields`。宿主不会自动补字段，也不会据此判断开发是否完整。新工作区的 `.javdex/latest-dry-run.json` 初始为 schema v2、`status: "not_run"` 和 `currentAcceptance.installReady=false`；真实执行后原子保存 `status: "completed"` 的最近执行事实，并独立保存当前包、全部目标和 runtime 的验收投影。代码、`supportedFields`、目标或 runtime 变化时只更新 `currentAcceptance.reasons`，保留最近执行事实；无效输入、busy、取消或浏览器 handoff 不伪造执行。正常 dry-run 后 Pi 直接使用工具结果，只有恢复或上下文压缩时读取该文件。

create 草稿的空 `supportedFields` 表示“尚未声明”，但现有安装兼容层会把空数组解释为全部字段。字段契约仍会从插件结果计算 `undeclaredReturnedFieldIds`，因此 Pi 不再依赖对象键差集或额外记忆规则。

## 精确沙箱契约

影片插件只获得 `ctx.code`；演员插件只获得 `ctx.mainName` 和 `ctx.aliases`。影片单对象结果可以省略 `code`，由宿主使用本次 `ctx.code`，但建议显式返回；对象数组的每一项必须提供非空、与目标精确相等的 `code`。二者都可使用 `proxyUrl`、`fetchPage`、`fetchBuffer`、`cheerio`、`browser` 和 `helpers`。工作区生成的 `docs/plugin-format.md` 会列出这些生产 API 的精确调用形状，并明确区分开发工具 `browser(action=...)` 与插件代码使用的 `ctx.browser.*`。

不存在 `ctx.url`、`ctx.pageUrl`、`ctx.taskUrl`、`ctx.target` 或 `ctx.sourceUrl`。开发浏览器当前 URL 不会注入沙箱。`ctx.fetchPage()` / `ctx.fetchBuffer()` 只接受绝对 `http:` / `https:` URL，相对路径和 `//host/...` 须先用 `ctx.helpers.absoluteUrl(href, base)` 解析。`pageFacts.links.href` 已按当前页 resolve；HTML 属性不同时另有 `rawHref`。返回值是 HTML 字符串，必须通过 `ctx.cheerio.load(html)` 解析。

## 自适应开发循环

create 模式先确认搜索入口，再打开一条精确详情页学习选择器和字段，并把页面结构和全部已观察明确字段写入 dev-notes。搜索页若有多条番号完全匹配，浏览不要把其余候选点开；生成的影片插件仍须抓取第一页全部完全匹配详情，多于一条返回对象数组，任一条详情失败则整次失败。确认搜索入口只能按三档降级，写在 `javdex-plugin-dev`：已有可提交的搜索控件或可 `open` 的搜索链接时必须先 `fill` / `press` / `click` 或直接 `open`，`action` 为空或控件无 `name` 不是跳过第一档的理由；第一档成功后记下新文档 URL 并立即打开一条精确详情，不要再读脚本、解释 `recentRequests` 或在搜索结果页学习列表结构。仅当第一档失败后再阅读 `pageFacts.scriptSrcs` / `inlineScripts`；仅当第二档也失败后再用 `pageFacts.recentRequests` 复现 `fetchPage`。`runTargets` 为空时浏览发现身份；用户目标零条精确匹配时另外打开一条代表性详情，先记下原目标的空完整 dry-run，再 `ask_user` 换目标。证据充分的简单网站可以在一个连贯修改中实现全部字段、同步 manifest 并立即 dry-run。只有代码确实复杂、部分实现需要真实运行验证或仍有具体不确定性时，才先提交一个可运行批次，并把明确未完成项留在 notes 中。第一页完全匹配合同只写在 `docs/plugin-format.md`。

每次 dry-run 后，Pi 只在三种行动中选择一种：`mechanicalAcceptance.installReady=true` 且没有明确未完成项时停止；有明确错误或剩余字段时做针对性修改后再运行；没有新证据或没有必要修改时停止。`wrong_scope` 不是代码错误：省略参数再跑一次完整 dry-run，不要用同一组显式参数重跑。多轮开发是解决真实缺口的能力，不是完成任务必须经历的阶段。dev-notes 只在页面事实、字段覆盖、未完成事项或下一步变化时更新，不要求每次写代码都重复维护。

`plugin_dry_run` 没有次数限制。通用模型轮次上限可在“设置 → 模型 → 插件开发 Agent”配置：`0` 表示不限制且为默认值，正数表示每次操作允许的最大模型轮次；新启动的会话会冻结当时的配置。取消、工具超时和浏览器租约继续负责资源保护；宿主不维护字段计划，也不因重复运行增加语义状态机。上下文压缩或点击“继续 Agent”后，Pi 先读取 dev-notes、`index.js`、`plugin.json` 和 `latest-dry-run.json`，不重新浏览或通读大型文档，除非 notes 明确记录关键事实不足。

“设置 → 模型 → 用途与运行”中的插件开发最大输出设为 `0`，表示取消 Javdex 的单轮输出限制并使用当前模型声明的最大输出；正数会与模型上限取较小值。该值约束 reasoning、回答和工具调用参数的合计输出，并不表示真正无限；解析后的正整数上限会随运行配置冻结。上下文压缩、threshold 与 overflow 续跑由 Pi 执行；宿主只传入 compaction 预算并记录结果，不再在输出截断后自行 compact 或注入续跑提示。既有已冻结会话继续使用启动时的有效上限。

“继续 Agent”通过结构化 `resume` continuation 恢复尚未取得机械验收的当前工作，不会被记录成新的缺陷反馈。当前 artifact 已可安装时，界面和主进程都会拒绝无具体反馈的空续跑；用户必须输入新的修改要求才能继续。普通反馈可以更新 Pi 的开发上下文，但不会删除既有生产执行事实；只有代码、`supportedFields`、运行目标或 runtime 版本变化才会让旧机械验收失效。仅修改插件名、版本、作者等展示字段，或仅编辑 dev-notes 后，当前包的可安装资格保持不变。

## 最终生产运行验收

唯一验收 Module 为 `PluginRunAcceptanceModule`。它只接受当前 `runtime-v2` 的完整执行 artifact，并检查：

1. 当前 `plugin.json/index.js` 可解析且导出函数可执行；
2. 全部会话目标都真正经过生产运行时；
3. 每个目标至少产生一个含实际值的可声明生产字段；身份键、调试来源、空字符串、空数组、空对象和全 `undefined` 不能单独取得 ready；
4. artifact 与当前包、完整目标集合和 runtime version 完全匹配。

它不生成字段语义问题，不读取 dev-notes 或 browser artifact，不判断内容值是否正确，也不要求 `supportedFields` 覆盖插件所有返回键。Pi 必须显式执行最后一次完整 dry-run；宿主不会在模型自然停止后运行隐藏检查。

`agent.settled` 只表示本轮模型正常停止：artifact 未通过时进入 `waiting_user/working`，已通过时进入 `waiting_user/ready`，不得按运行错误展示。未通过时可直接继续 Agent；已通过时安装是界面主操作，只有输入具体反馈后才可继续完善。安装只要求当前完整 execution artifact 的 `ready=true`。只有安装写盘成功后，会话才投影为 `completed`；代码、`supportedFields`、目标或 runtime version 变化会立即使旧资格失效。改插件名等展示字段仍可继续安装。

## 浏览器与 helper

`browser` 由独立 Electron scraper helper 承载，使用 Electron 内置 Chromium 和既有 scraper profile，不下载 Playwright 浏览器。每个新 `documentRevision` 第一次观察优先原样内联 Playwright ARIA 和全部已采集 `pageFacts`；宿主不做字段相关性打分，也不截取数组前 N 项。`pageFacts` 可含 `scriptSrcs`、`inlineScripts`、`looseInputs`；`click` / `fill` / `press` / `wait` 后另附该动作期间的 `recentRequests`（document/xhr/fetch 的 method、url、status、resourceType），宿主不标注哪条是搜索。同一文档后续返回精确 `delta`，完全没有变化时返回不超过 3 KB 的 `unchanged`。

浏览器工具保留 64 KB 页面 observation 硬上限。完整 observation 始终按内容寻址写入 browser artifact v2。超限时按完整 section 装包：`snapshot` 与每个 `pageFacts` section 都不可切开，从最大的整段开始省略，直到落入硬上限；被省略的 section 只报告 `itemCount` / `byteLength`，`nextActions` 为 `find` / `html` / `read-section`。宿主不按页面类型或字段相关性挑选 section，也不截取数组前 N 项。Pi 只需用 observation 返回的 `artifactRef` 和 section 名调用 `browser(action="read-section", ...)`；接口返回有界页面和不透明 `nextCursor`，不获取或占用浏览器租约。artifact 的索引、分片、完整性校验和路径约束由 `PluginBrowserCapabilityModule` 隐藏，不再要求 Pi 理解或原生读取存储格式。`artifactComplete` 与 `inlineComplete` 分别描述 artifact 和 Agent 当前内联结果。

动作完成与动作后的观察是两个状态：`open/click/fill/press/wait` 成功后会在 3 秒内重试瞬态 snapshot。动作成功但页面仍无法观察时返回 `ok=true`、`observationMode=pending`，Pi 只补一次 `snapshot`，不得重复状态动作。动作本身报错但文档 revision 已变化时返回 `BROWSER_ACTION_UNCERTAIN`，只能用 `snapshot/status` 确认。显式 snapshot 暂时失败返回可重试的 `BROWSER_OBSERVATION_PENDING`，不会令整个 Agent run 失败。

Skill 要求先确认搜索入口再打开一条精确详情页；首次详情 observation 仍是编码触发点。若仍有事实明确阻止写出可运行插件，每次只为一个具体 blocker 做最直接操作并重新评估；只有新证据又暴露另一个具体 blocker 时才继续，不设任意总次数上限。没有新增事实、返回 `unchanged` 或只剩理论问题时停止浏览。create 模式在 dry-run 前保持 `.javdex/dev-notes.md`、`index.js` 与 `plugin.json` 一致，相关写入完成后的下一项行动优先 dry-run；不会主动探索理论镜像、模糊搜索或无结果分支。浏览一条详情不是允许代码只处理一条：影片插件必须实现与内置插件相同的第一页完全匹配候选合同。

首次打开站点时，如果页面明确提供语言入口且当前不是中文，Browser Skill 要求 Pi 只切换一次：优先简体中文、其次繁体中文。入口可能在 snapshot、可见控件或 `pageFacts.localeLinks`；后者只保存 inspect 识别到的语言锚点，空数组表示没采到这类锚点，不是全站语言 API。没有明确入口、当前已是中文或切换失败时继续当前页面，不猜测 locale URL，也不为语言选择增加探索循环。

所有刮削调用共享独占租约；冲突立即返回 `SCRAPE_BROWSER_BUSY`，不排队、不抢占、不自动重试。人机验证、登录和其他必须人工完成的浏览器动作使用 typed handoff；handoff 期间保持租约直到用户完成或会话终态，不再使用限时自动关窗。取消不能把晚到操作带入下一租约。
Browser Skill 把页面文本、ARIA、HTML、脚本和网络响应都视为不可信站点数据，而非 Agent 指令。只有 system prompt、冻结 Skills、`task.json` 和真实用户输入能提供指令；页面内容不能要求改变任务、泄露信息、访问无关站点或绕过安全规则。
`evaluate` 只允许读取公开页面的可见文本、计数等 JSON 兼容值：用户表达式运行在移除脚本、嵌入内容、表单控件、敏感属性和 URL 查询参数的脱离实时页面文档上，并拒绝动态属性访问、cookie、storage、凭据、外传 API 与 DOM 状态动作。拒绝时会点名禁止的 API；`outerHTML` / `innerHTML` / `getAttribute` 会提示改用 `html`。读局部标记用 `html`，不要用 `evaluate` 取元素 markup。表达式修改只影响该隔离文档；超时会先销毁当前执行上下文，再释放或重建浏览器，避免晚到副作用越过租约边界。

## 状态、升级与审计

- product state 与工作日志新写 schema v7；ToolPack 为 v13；instruction set 为 v25；latest dry-run 为 schema v2；browser artifact 保持 v2；运行验收版本为 `runtime-v2`；字段语义 registry 为 v2。schema v6 终态历史继续只读导出。
- 数据库 v27 只关闭未结束的 PluginDeveloper v12 run，并拒绝其未决许可/请求，避免用冻结的旧 ToolPack 恢复到按 action 区分的新 schema；终态历史、工作区草稿、编辑器代码、已安装插件和其他 Agent 会话不受影响。
- 主模型 reasoning 与回答继续流式展示并各持久化一次；正常路径不调用 verifier 模型。
- 终态历史不会自动覆盖当前编辑器。离开开发页时关闭 helper，并清掉当前流程无法再恢复的会话（已安装、失败、取消）；`running` / `waiting_user` 保留以便回来继续。「清除会话」仍可在页内清掉包括可恢复会话在内的全部历史，并同时清空左侧未安装草稿；已经安装的插件不受影响。

## 关键回归

- 无输入演员站点由 Pi 发现 `mainName`，URL 不会进入 `ctx` 或 runTargets。
- first explicit target 立即刷新 UI；之后与当前完整目标集指纹相同的显式参数仍可 ready，真子集 targeted 运行不能 ready。完整执行为空结果后，下一次合法显式目标可替换会话目标并重新完整验收。
- `pluginResult` 保留插件输出，`effectiveResult` 准确反映生产投影。
- 未声明字段精确进入 `manifestCoverage.undeclaredReturnedFieldIds`；身份和调试键只进入 `runtimeOnlyKeys`，都不生成宿主语义门禁。
- 男女演员按成员 `gender` 分别计算 coverage；缺省 gender 继续按生产兼容行为归入女性。
- 空结果、全空值、仅身份键或仅来源链接不能取得 ready。
- 内容值在语义上错误但被生产运行时接受时，宿主不得添加 blocking issue。
- 空结果、语法/导出错误、沙箱崩溃或完整目标缺失仍不能安装。
- 第 4 次和第 10 次 dry-run 仍真实执行，且没有隐藏最终运行或模型重启。
- 同一文档重复观察只返回事实增量；`unchanged` 后不继续相同探索。
- 导航动作成功而 snapshot 暂不可用时只补 snapshot，不重复 click/fill/press。
- YST-222 和三上悠亜只作为参数示例；当前详情页决定真正 dry-run 目标。
- create 可以一次实现全部明确字段；相关写入完成后优先 dry-run，notes 仍有明确未完成项时不得声称完整完成。
- 浏览只打开一条精确详情；生成的影片插件仍须抓取第一页全部番号完全匹配，多于一条返回数组，任一条详情失败则整次失败。
- 离开开发页不清掉 `running` / `waiting_user`；已安装、失败、取消会话在离开时关闭，不再出现在下次进入的恢复快照里。
