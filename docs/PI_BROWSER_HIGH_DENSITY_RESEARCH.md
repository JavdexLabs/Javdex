# 复现直接 Pi 浏览器 Skill 高信息密度体验

> 调研日期：2026-08-21
> Pi 版本：[`@earendil-works/pi-coding-agent v0.84.2`](https://github.com/earendil-works/pi/tree/v0.84.2/packages/coding-agent)
> public Pi Browser Skill 快照：[`badlogic/pi-skills@90bb51c`](https://github.com/badlogic/pi-skills/tree/90bb51cae36515a648515b633a81c0c6efc8c74d/browser-tools)
> 分析回放：用户导出的 `plugin-dev-agent-missav-6e020ea1-2026-08-21T12-40-29.json`（未纳入仓库）

## 结论

要复现的不是一个更长或更聪明的页面摘要，而是下面这组交互属性：

1. **模型在页面端按当前问题投影数据**，而不是宿主先生成固定大报告、再截取开头。
2. **一次调用可以批量执行动作、等待并返回最终观察**，而不是每个 click/type/wait/query 各占一个模型 turn。
3. **默认观察是可直接操作的语义状态**，节点同时带角色、名称、状态和临时 `ref`；CSS selector 只是写插件时的提示，不是浏览器操作的唯一地址。
4. **初次返回完整紧凑状态，后续只返回变化**；无变化时明确停止，不重复抓取。
5. **详情页字段事实和搜索页候选是一级结果**；正文、完整 DOM、截图和 artifact 是按需降级路径。

Pi 核心本身没有“原生浏览器”。Pi 原生提供 Agent loop、Skill 渐进加载和扩展工具机制；直接 Pi 的浏览器体验来自外部 Browser Skill/脚本或扩展。[Pi 默认工具只有文件和 shell 工具](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/README.md#tool-options)，[Skill 只是在匹配后加载的工作流说明](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/skills.md#how-skills-work)。因此，只在 Javdex 工作区生成一个名为 `javdex-browser-operation` 的 `SKILL.md`，并不会自动获得直接 Pi Browser 的数据面能力。

当前 ADR-0021 的方向仍然成立：Pi 应拥有开发循环，Electron 浏览器只做 Adapter；但“复用 Pi Skill 的 Interface”尚未真正实现。ADR 规定模型应看到与直接 Pi 基线一致的 Interface，[当前代码实际仍是单动作、CSS selector 驱动的自定义工具](./adr/0021-use-pi-native-plugin-development-workspaces.md#4-浏览器复用-pi-skill-的-interface)。

## “直接 Pi 浏览器”实际包含什么

### Pi 提供的是装载机制，不是浏览器

Pi v0.84.2 的内置工具是 `read / bash / edit / write / grep / find / ls`；额外能力由 Skills、Extensions 或 packages 提供。[Pi README](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/README.md#tool-options) Skill 的常驻上下文只有名称和描述，全文在任务匹配后再通过 `read` 加载，这是渐进披露，不是一个浏览器 runtime。[Pi Skills 文档](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/skills.md#how-skills-work)

这一区分很重要：

- `SKILL.md` 决定模型**如何使用能力**；
- Extension、CLI、CDP 或宿主 Adapter 决定模型**实际拥有什么能力和返回什么数据**；
- 高信息密度主要由第二项决定，不能靠提示词弥补低密度工具结果。

### public `pi-skills/browser-tools` 的关键能力

badlogic 的 public Browser Skill 很可能接近用户所说的直接 Pi 基线。它通过 `bash` 调用 Puppeteer/CDP 脚本，并允许模型把任意页面端表达式交给 `browser-eval.js`。[Skill 源码](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/browser-tools/SKILL.md) · [`browser-eval.js`](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/browser-tools/browser-eval.js)

它的效率指南明确要求：

- 优先 DOM 检查而不是截图；
- 把多语句提取包进一次 IIFE；
- 批量完成多个交互；
- 一次返回当前任务需要的结构化状态；
- 先做紧凑页面结构投影，再针对性定位元素。[Browser Skill efficiency guide](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/browser-tools/SKILL.md#efficiency-guide)

正文类页面另有 `browser-content.js`：它通过 CDP 获取 DOM，再用 Mozilla Readability 和 Turndown 只输出可读正文，而不是完整 HTML。[`browser-content.js`](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/browser-tools/browser-content.js)

这套方案的高密度来自**源端投影**：模型决定查询哪些节点、返回哪些属性。它不依赖固定 3 KB 预算，也不会先构造 60 KB 通用页面对象再让模型寻找字段。

### Codex bundled Browser 提供的另一组成熟做法

本机 bundled Browser 不是 Pi 原生能力，也没有可供 Javdex 直接嵌入的稳定公共 API；但它给出了值得复现的交互契约：

- 默认用 accessibility state，而不是 HTML 或 screenshot；
- 操作用观察结果中的临时元素索引；
- 操作后重新观察，避免复用过期索引；
- 后续观察默认返回 accessibility tree diff；
- 多个动作与最终观察批进一次持久 JavaScript 调用；
- 只有需要 selector ground truth 时才切到 DOM/Playwright；
- 一个权威信号已经回答问题后停止重复验证。

依据来自调研时安装的 Codex Browser package 中 `accessibility.md`、`api-use-behavior.md` 和 `api.json` 快照；这些环境文件不作为仓库内链接。Playwright 的公开实现也已提供 `mode: "ai"` 的 ARIA snapshot：它保留可交互节点 `ref`、角色、名称、状态、URL、placeholder 等 AI 所需信息，而不是输出所有 DOM 属性。[Playwright `ariaSnapshot` 实现](https://github.com/microsoft/playwright/blob/8885923554e7d97799f5a83416e5539492e25060/packages/injected/src/ariaSnapshot.ts) · [公开 API 文档](https://github.com/microsoft/playwright/blob/8885923554e7d97799f5a83416e5539492e25060/docs/src/api/class-locator.md)

public Pi Skill 和 Codex Browser 的共同点不是具体库，而是：**源端投影、可操作语义、批处理、持久状态、增量观察、按需降级。**

## 本次 MissAV 回放说明了什么

本次 create run 从 `12:35:57.862` 到 `12:40:10.433`，约 4 分 13 秒后进入 `waiting_user`，仍未修改 `index.js`，也没有调用 `plugin_check`。附件中的可复核统计如下：

| 指标 | 实际值 |
|---|---:|
| 模型 turns | 24 |
| 工具调用 | 33 |
| browser | 13（`open` 7，`evaluate` 6） |
| 文件工具 | 20（`read` 10，`ls` 5，`grep` 4，`find` 1） |
| write/edit/plugin_check | 0 |
| 累计 tokens | 642,071 |
| uncached input | 36,872 |
| cache read | 595,328 |
| output | 9,871 |
| reasoning | 6,376 |
| 最终活动上下文估算 | 45,050 tokens |
| 13 个 browser artifacts | 646,172 bytes |

### 浏览器已经抓到答案，但普通结果没有交给模型

详情页 artifact `7ccafe1b37872d9ca25a5d6c.json` 为 62,872 bytes，其中已经包含：

- 精确 URL 和标题；
- 9 条 `labeledRows`：發行日期、番號、標題、女優、男優、類型、發行商、導演、標籤；
- 18 条 metadata，包括 `og:title / og:url / og:image`；
- 表单、100 个链接和关键 DOM 区域。

也就是说，写第一版插件需要的 search path、精确详情页、title、cover 和 source 已经存在。抓取器并没有失败。

但当前 formatter 的顺序是 URL/title → 大段 `body.innerText` → forms → links → structured facts，[见 `formatPageInsightForPrompt`](../apps/desktop/src/main/services/pluginDevPageFormat.ts#L73)。随后 Browser capability 不根据 typed page 选择高价值字段，而是直接取 `result.content` 的前 2,200 bytes，[见 `PluginBrowserCapabilityModule`](../apps/desktop/src/main/services/pluginDevAgent/browserCapability.ts#L83)。因此普通结果被推荐影片正文占满，在到达 `labeledRows` 前已经截断。

模型为补足信息读取了完整 artifact。Pi 原生 `read` 默认允许最多 50 KB 或 2,000 行，[见 Pi `read` 实现](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/tools/read.ts)，该次 read 实际向模型加入 43,535 字符；活动上下文估算随后从 10,962 跳到 27,709 tokens。Artifact 又同时保存格式化 `content` 和 typed `page`，形成重复表示，[见当前 artifact 构造](../apps/desktop/src/main/services/pluginDevAgent/browserCapability.ts#L83)。

### 搜索结果存在，但不能直接操作

搜索页 artifact 已把两个目标详情 URL 排在最前，但链接文本为空；搜索卡片的可见标题在后代节点中。当前 `inspect` 只读取 anchor 的 `innerText/title` 并返回 `parentSelector`，[见链接提取](../apps/desktop/src/main/scrapers/scrapeBrowser.ts#L1052)，没有 computed accessible name，也没有可点击 `ref`。模型只能再用 `grep` 找 URL、用 `evaluate` 自己重建卡片关系。

当前 `click/type` 只接受 CSS selector，[见 `executeBrowserAction`](../apps/desktop/src/main/services/pluginDevAgent/toolExecutor.ts#L215)；工具 schema 又规定每次只能执行一个 action，[见 browser schema](../apps/desktop/src/main/services/pluginDevAgent/toolSchemas.ts#L51)。所以“输入搜索词 → 提交 → 等待 → 获取候选”无法在一个工具调用中完成。

### 3 KB 不是根因，错误的压缩边界才是

把输出硬限制为 3 KB 看似节省上下文，实际触发了 43 KB artifact 回读和 6 次 `evaluate`。本次回放说明：

> 高信息密度不是更小的字节数，而是每个字节都能直接支持判断或下一步动作。

如果详情页结果先返回 9 条标签事实和 3 条核心 metadata，即便总量是 4–6 KB，也会比当前 2.2 KB 正文前缀更便宜。

## 推荐架构：Browser Investigation Module

建议把 Browser capability 做成一个深 Module。Pi 和 PluginDeveloper 只看到一个稳定 Interface；Electron/CDP、diff、ref、artifact、字段事实提取和输出预算都留在 Implementation 内。

```text
Pi Agent
  ├─ javdex-browser-operation Skill     # 何时 observe / act / query / stop
  └─ browser tool adapter               # JSON schema + Pi tool result
       └─ BrowserInvestigationModule    # 深 Module
            ├─ BrowserPort              # 生产：Electron/CDP；测试：fixture
            ├─ ObservationProjector     # semantic / fields / content / dom
            ├─ RefRegistry              # revision-scoped ref → node
            ├─ ObservationDiffer        # 初次 full，后续 diff
            └─ BrowserArtifactStore      # 完整证据，不进入普通上下文
```

### 唯一外部 Interface

```ts
interface BrowserInvestigationModule {
  execute(command: BrowserCommand, signal: AbortSignal): Promise<BrowserObservation>
}

type BrowserCommand =
  | { op: 'navigate'; url: string; observe?: ObserveSpec }
  | { op: 'observe'; observe?: ObserveSpec; full?: boolean }
  | { op: 'act'; revision: number; steps: BrowserStep[]; observe?: ObserveSpec }
  | { op: 'query'; revision: number; query: BrowserQuery }
```

一个 `browser` Pi tool 用 discriminated union 映射该 Interface。不要再暴露 `open/snapshot/html/evaluate/click/type/press/wait/status` 这组扁平低层 action；这些是 Module 内部实现细节。

### Observation 模式

`ObserveSpec.mode` 应明确区分用途：

| 模式 | 默认场景 | 返回内容 |
|---|---|---|
| `semantic` | 首页、搜索页、交互页 | landmarks、controls、links/cards、角色、名称、状态、URL、临时 ref |
| `fields` | 详情页 | identity、visible labeled rows、definition lists、JSON-LD、核心 metadata、相关链接 |
| `content` | 文档/文章 | 主正文 Markdown；过滤 nav/header/footer/aside |
| `dom` | selector 调试 | 指定 ref/selector 附近的紧凑 DOM，绝不默认全页 |
| `both` | 页面类型尚不明确 | 有预算的 `semantic + fields`，不含完整正文/DOM |

默认可自动选择：搜索/列表页优先 `semantic`，详情页优先 `fields`。自动选择只能决定表示方式，不能做站点字段语义映射或替 Pi 下结论。

### 可操作的语义节点

每个节点同时包含浏览器操作句柄和插件开发提示：

```json
{
  "ref": "r7:e17",
  "role": "link",
  "name": "SSIS-123 假裝沒注意到的刻意走光…",
  "url": "https://missav.ws/dm59/ssis-123",
  "states": { "visible": true },
  "selectorHint": "a[href='/dm59/ssis-123']"
}
```

- `ref` 只在当前 `revision` 有效，用于 click/fill/scroll；导航或结构变化后旧 ref 必须 fail closed。
- `selectorHint` 是 Pi 写 Cheerio 代码时的候选，不承诺跨页面 revision 稳定。
- accessible name 应使用浏览器计算语义，解决 anchor 自身文本为空、可见标题来自后代节点的问题。

Electron 已能通过 `webContents.debugger.sendCommand()` 使用 Chrome DevTools Protocol。[Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger) CDP `Accessibility.enable` 会让 AX node id 在调用间保持一致，`getFullAXTree/getPartialAXTree` 返回 role、name、value、properties 和 `backendDOMNodeId`，足以实现 ref registry 与 DOM 关联。[CDP Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/) 生产 Adapter 应在 Electron 当前 Chromium 版本上做协议能力探测，不能假定 tip-of-tree 实验字段永远存在。

### 批量动作与最终观察

最有杠杆的改造不是新增更多 action，而是允许一次调用完成完整小流程：

```json
{
  "op": "act",
  "revision": 3,
  "steps": [
    { "action": "fill", "ref": "r3:e8", "value": "SSIS-123" },
    { "action": "press", "ref": "r3:e8", "key": "Enter" },
    { "action": "waitFor", "condition": "semantic-change", "timeoutMs": 10000 }
  ],
  "observe": { "mode": "semantic", "focus": "main", "query": "SSIS-123" }
}
```

结果直接带新 revision 和搜索候选，不需要 `type → press → wait → snapshot` 四个模型 turns。每个 step 仍由宿主 allowlist 校验；失败时返回执行到哪一步和最新可见状态。

### 受控 query projection 代替任意 `evaluate`

public Pi Skill 的任意页面 JavaScript非常灵活，也是高密度的重要来源，但不能原样复制到 Javdex。它继承 `bash` 和浏览器页面的能力，能读取 cookie、修改 DOM、发起间接网络请求，不符合当前最小 capability 边界。

首期应提供声明式 query DSL：

```ts
type BrowserQuery = {
  root?: { ref?: string; selector?: string }
  each?: string
  fields: Record<string,
    | 'text' | 'accessibleName' | 'href' | 'src' | 'outerHTMLPreview'
    | { attr: string }
    | { style: 'backgroundImage' }
    | { descendant: string; value: 'text' | 'href' | 'src' }
  >
  filter?: { field: string; includes?: string; equals?: string }
  limit?: number
}
```

它足以一次提取 MissAV 搜索卡片的标题、href、封面和 code，也能取详情页 background image；输出字段由模型指定，但可执行操作由宿主限制。只有 fixture 证明 DSL 无法覆盖常见站点后，才考虑在隔离进程中增加只读脚本投影。

### 初次 full，后续 diff

Module 为每个 tab 保存上次 observation 的规范化 hash：

- 同 URL 首次观察返回 full；
- 操作后返回 added/changed/removed nodes 和 changed field facts；
- `changed:false` 时 Skill 明确禁止无动作重读；
- URL、document identity 或主要 frame 改变时自动返回新 full observation；
- `full:true` 只用于模型能说明缺失上下文的情况。

这比“每次重新生成 12 KB，再从头截 2.2 KB”更接近直接 Browser 的上下文行为。

### 输出预算按 section 分配，不做全局前缀截断

建议普通 full observation 预算 6 KB，diff 3 KB，精确 query 8 KB；预算是上限，不是必须填满。优先级固定为：

1. page identity、URL、title、challenge/status；
2. 与当前 query/target 匹配的 candidates 或 visible field facts；
3. 可操作 controls/links 及 ref；
4. JSON-LD 和核心 metadata；
5. selector hints 和小段 DOM preview；
6. 正文摘要；
7. navigation/locale/重复链接。

每个 section 独立限额，结果必须返回 `omittedSections` 和可用的针对性 query 提示。禁止 `truncateUtf8(result.content, 2200)` 这类全局头部截断。

### Artifact 只做证据仓，不做常规第二页结果

完整证据仍应保存，但拆成可独立读取的分区，且不重复保存同一表示：

```text
.javdex/browser/<observation-id>/
  manifest.json
  semantic.json
  fields.json
  links.jsonl
  dom.html
  screenshot.png       # 仅实际采集时存在
```

普通结果给出 `observationId` 和分区清单。Pi 常规流程不应使用原生 `read` 打开完整 artifact；确需补充时调用 `browser query` 或只读具体分区/行段。产品工作日志也只记录 compact observation 与 artifact hash，不复制完整页面。

## Skill 应如何变薄

新的 `javdex-browser-operation` Skill 只保留决策规则，不重复工具 API 文档：

1. 初始使用 `navigate + both` 或 `semantic`。
2. 搜索/交互优先 ref；把 fill/press/wait/observe 合成一次 `act`。
3. 搜索页看 candidates，详情页看 fields；只有缺失明确属性才 query。
4. DOM 只用于产生 scraper selector，截图只用于视觉歧义。
5. 找到精确详情页、搜索路径和 2–3 个核心字段后立即写第一版。
6. 权威信号已经回答问题后停止横向验证。
7. `changed:false` 不得重复观察；无新证据时回到编码或 `plugin_check`。

Tool schema、运行时 documentation 和 Skill 使用同一版本化定义生成，避免提示词声称支持批处理而 Adapter 仍是一动作一调用。

## 分阶段落地

### Phase 1：先修信息损失

- compact result 直接从 `PluginDevPageInsight` 构建，不再截格式化字符串头部；
- 详情页先输出 identity、labeled rows、JSON-LD、核心 metadata；
- 搜索页先输出匹配 target 的候选和真正的搜索 control；
- artifact 删除重复 `content + page`；
- 常规路径不再提示 Pi 整体读取 artifact。

这一阶段不改变底层 Electron 浏览器即可显著改善本次 MissAV 症状。

### Phase 2：复现直接交互范式

- 新增 revision-scoped refs；
- `act.steps[]` 支持批量动作与最终观察；
- 增加声明式 query projection；
- 删除 Agent 可见的独立 `html/evaluate/wait/status` action。

### Phase 3：增量状态与真实语义

- 通过 Electron CDP Adapter 获取 AX tree 和 backend DOM node；
- semantic full/diff；
- ref 与 selector hint 分离；
- fixture Adapter 回放同一 Interface。

### Phase 4：再评估可编程脚本

只有真实回放证明 query DSL 明显降低成功率时，才评估隔离进程中的只读 projection runtime。不能为了复制 public Skill 的表面接口重新开放 Pi `bash` 或不受控页面 JavaScript。

## 验收和 A/B 评估

“输出不超过 3 KB”不应再作为核心成功指标。使用相同模型、相同 prompt、相同 MissAV target，直接 Pi 基线与 Javdex Adapter 至少比较：

| 指标 | 建议目标 |
|---|---:|
| 搜索输入、提交、等待、候选提取 | 1–2 browser calls |
| 找到精确详情页后的额外 browser calls | ≤ 1 |
| 第一次修改 `index.js` | ≤ 第 8 个模型 turn，且详情页后 60 秒内 |
| 第一次 `plugin_check` | ≤ 6 次 browser calls 后 |
| 常规 artifact 整体回读 | 0 |
| 重复同页 full observation | 0；后续应为 diff/query |
| `evaluate` 等逃生口调用 | 常规任务 0 |
| 详情页 fields 覆盖 | 一次 observation 含番号、标题、封面/source 证据和主要标签行 |
| selector 首次命中率 | 单独统计并高于当前基线 |
| 最终正确率 | 不低于直接 Pi + Browser Skill 基线 |

同时记录：到第一次 edit/check 的 uncached input、cache read、output、reasoning、browser bytes、artifact bytes，以及“下一次行动实际引用的结果字段 / 返回字段”比例。后一个指标比单纯 token 数更接近信息密度。

MissAV 固定回归应至少断言：

- 搜索 observation 同时返回两个 `SSIS-123` 候选的可见名称、精确 href 和 ref；
- 详情 observation 在普通结果中直接返回 9 条 labeled rows 和 `og:image`；
- 不读完整 artifact、不调用任意 evaluate 也能写出第一版；
- 正确详情页出现后继续横向探索超过一次时，Skill/宿主给出非阻塞 stop hint；
- ref 跨 revision 使用会失败并附最新紧凑状态；
- 无页面变化时返回 `changed:false`，不重复完整内容。

## 风险与未证实项

- 没有用户那次“直接 Pi + Browser Skill”成功 run 的导出日志，因此无法确认它具体使用的是 `badlogic/pi-skills/browser-tools`、另一个自定义 Skill，还是相似实现；本报告只提炼 public Pi Skill、Codex Browser 和本次 Javdex 回放的共同可证实属性。
- Codex bundled Browser 是私有应用能力；本地能验证其文档和压缩后的客户端，但不能把它视为 Javdex 可依赖的公共 SDK。
- CDP Accessibility 的部分方法标记为 experimental。必须用 Electron 当前 Chromium 做启动能力探测，并保留 DOM semantic Adapter fallback。
- AX tree 适合交互，但不会覆盖 `og:image`、JSON-LD、CSS background 等 scraper 信息；因此只复制 accessibility snapshot 不够，必须保留并提升 `fields/query` 通道。
- public Pi Skill 的任意 JS 是效率与权限的交换。Javdex 应复现其“按需投影”效果，而不是复制其安全模型。

## 最终判断

当前架构的问题不是 Pi Agent 本身，也不是 Electron 浏览器抓取能力不足，而是 Browser Module 不够深：它把所有页面表示、压缩和操作细节泄漏给 Agent，再用提示词要求 Agent自行收敛。

最值得实施的设计是：

> **一个持久的 Browser Investigation Module，默认返回可操作语义和详情字段事实，支持批量动作与源端 query，后续只返回 diff；Pi 负责选择证据和写代码，宿主不再替 Pi 做语义推理。**

这会真正复现直接 Pi Browser 的高信息密度，同时保留 Javdex 需要的 Electron 会话、Cloudflare handoff、权限边界和可重放测试。
