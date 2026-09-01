# 外部清单 Agent 导入设计与实施计划

- 状态：Implemented / released in 0.6.0 / hardened in 0.6.1
- 日期：2026-08-30
- 方案：新建/追加统一入口
- 数据库版本：V14（首次随 0.6.0 从已发布的 V13 升级；0.6.1 不新增迁移）

当前已完成共享 browser scroll/viewRevision、Session 内导入暂存与匹配仓储、清单引用保护、
跨媒体库清单投影、清单详情资源筛选、生产 Agent 运行驱动、IPC/preload、统一导入弹窗和
同一前台 Session 内的浏览器交接。软件退出、主进程终止或浏览器会话丢失后不恢复导入。
发布门禁继续用打包产物 smoke
验证浏览器 helper、Cheerio/undici 依赖链和生产运行时；站点 DOM 结构差异仍由页面 selector
检查点显式失败，不以猜测结果完成。

## 1. 决策摘要

Javdex 新增一个独立的“外部清单导入”Agent 定义和一个深的 `PlaylistImportModule`。用户提供外部清单 URL，在任务开始前选择目标媒体库，并选择以下一种目标：

- **新建清单**：导入成功时创建一个新清单并加入全部影片。
- **追加到清单**：把全部影片追加到一个已有清单。

两个入口使用同一份任务类型、状态机、Agent 工具包、当前连接 TEMP 暂存和最终应用事务。UI 不负责循环分页、匹配影片或逐条写入。

V1 同时扩展共享 Agent browser：增加受控纵向 `scroll`、滚动 metrics、独立 `viewRevision` 和滚动后旧 ref 失效。通用 browser 是 Agent 的页面控制面，可以打开来源、关闭遮挡、完成同站点导航、输入与滚动，也可以在 handoff 后自行返回冻结工作项；这些动作不认领或推进导入 frontier。清单 selector 提取、虚拟列表的回顶、连续性、终点判断和逐窗口 Session 检查点仍由 `PlaylistImportAgentRunDriver` 的领域工具封装，Agent 不直接提交像素、批次号或滚动 token。当前未封存页重试时从该页顶部重新读取，不重放软件退出前的滚动链。

核心流程固定为：

```text
冻结用户输入
  → 完整读取并逐页固化外部清单
  → 清单分页全部结束
  → 只为待消歧条目读取详情页
  → 用户处理剩余身份歧义
  → 单个 SQLite 事务创建/复用影片并写入清单
```

影片快速匹配在全局目录执行，目标媒体库不是候选边界：

1. 全局规范化番号完全匹配 **0 条**：“自动创建无资源影片”开启时在目标媒体库创建新影片，关闭时跳过该条目；列表页没有可靠番号时必须先读详情页。
2. 全局规范化番号完全匹配 **1 条影片 ID**：直接复用，不主动打开详情页，也不把它迁入目标媒体库。
3. 全局规范化番号完全匹配 **多条影片 ID**：打开该外部影片的详情页，用强身份信号进一步匹配。
4. 强身份信号唯一命中时直接复用该影片，即使它只属于其它媒体库。
5. 详情身份仍留下多个候选时，如果恰好一条候选属于用户指定的目标媒体库，则用目标媒体库作为决胜偏好；否则暂停任务，由用户选择已有影片或明确创建新影片。

“自动创建无资源影片”与“保存详情页到相关链接”默认开启；“保存来源清单链接”默认关闭。关闭前者时，自动流程会跳过未匹配条目；关闭第二项时，最终影片不写入外部详情 URL；开启第三项时，外部清单 URL 会去重追加到目标清单的相关链接。导入不创建 `video_resources`，不下载影片资源，不覆盖已有影片元数据或用户维护的相关链接。

无资源影片不再依赖导入专用 `is_pinned` 标记保活。统一规则是：只要影片仍被任一清单引用，媒体库扫描和全局无资源影片清理都不得自动移除它；用户显式删除不受影响。

## 2. 与现有领域模型的关系

### 2.1 全局目录和媒体库

Javdex 的影片资料属于全局目录，媒体库只保存成员关系和库内资源。同一全局影片可以属于多个媒体库，清单也属于全局目录，而不是某个媒体库。参见 [CONTEXT.md](../CONTEXT.md) 和 [ADR-0023](adr/0023-share-catalog-metadata-across-media-libraries.md)。

本功能中的“目标媒体库”决定：

- 新建影片要在哪个媒体库中创建可见成员关系。
- 多个跨库重复影片在详情身份仍不能唯一选择时，优先使用哪个媒体库中的候选。

目标媒体库不限制已有影片查找，不要求被复用影片迁入目标媒体库，也不是清单归属。清单直接引用全局影片 ID，可同时包含来自多个媒体库的影片。由于清单本身是全局对象，清单引用保护也按全局影片 ID 生效：一部影片只要仍在任一清单中，所有自动清理路径都跳过它。这个规则刻意换取简单性，可能同时保留该影片在多个媒体库中的无资源成员；用户仍可显式移除这些成员。

### 2.2 全局唯一番号快速复用是导入策略，不是影片身份定义

[ADR-0015](adr/0015-separate-video-record-identity-from-business-identity.md) 规定：永久内部影片 ID 是记录身份，完整业务身份由“发行商实体 + 规范化番号 + 发行日期”构成；同番号影片允许并存。

因此，“全局目录内唯一完全匹配番号直接复用”必须被定义为当前导入用例的产品策略，而不是新的全局唯一性规则：

- 它在全局影片目录内查找候选，按影片 ID 去重；同一影片属于多个媒体库仍只算一个候选。
- 它不新增番号唯一索引。
- 它不改变影片合并、刮削、扫描或手动资源导入的身份规则。
- 唯一同番号匹配有误时，仍通过现有影片纠正/合并能力处理。
- 目标媒体库只在创建新影片和多候选详情阶段的最后决胜时生效，不能覆盖指向其它媒体库候选的唯一强身份信号。

这个取舍优先满足外部清单导入的低交互体验，同时把重复番号风险限制在一个明确的用例中。实施前应新增 ADR，记录该例外策略和风险。

### 2.3 新领域术语

实施时应在 [CONTEXT.md](../CONTEXT.md) 增加：

**外部清单导入任务**：用户明确授权的一次前台 Agent Session；它从一个外部 HTTP/HTTPS 清单完整枚举影片，将输入目标、页面证据和影片决定暂存在当前进程内，全部条目可解析后再把影片原子加入一个内部清单和指定媒体库。

**外部清单影片候选**：外部清单中一条具有稳定详情页 URL、来源顺序，以及可选番号和标题的影片条目；它在最终应用前不是媒体库影片，也不是影片资源。

**导入番号快速复用**：外部清单导入在全局目录发现唯一规范化番号完全匹配影片 ID 时直接复用的用例策略；它不构成全局影片业务身份，也不适用于多个同番号影片 ID。

**清单引用保护**：清单对影片形成的显式保留关系；只要影片仍被任一清单引用，自动清理不得移除其无资源媒体库成员或全局影片记录。该术语和规则已同步到 [CONTEXT.md](../CONTEXT.md)。

**外部清单导入目标媒体库**：承接本次新建影片，并在详情身份仍留下跨库重复记录时提供影片选择偏好的活动媒体库；它不限制已有影片查找或清单引用范围。该术语已同步到 [CONTEXT.md](../CONTEXT.md)。

## 3. 目标和非目标

### 3.1 目标

- 一个统一入口同时支持“从外部清单新建”和“向已有清单追加”。
- 用户在开始前明确选择目标媒体库。
- 普通分页、编号分页和显式“加载更多”必须读完后才能进入身份处理。
- V1 支持有限虚拟滚动和滚动触发的懒加载清单；每个渲染窗口必须在 DOM 节点回收前形成检查点。
- 每个清单页离开前形成当前 Session 的页面检查点。
- 列表页全部固化后才允许读取影片详情页。
- 完整导入前不修改清单、影片或媒体库成员。
- 复用决定、按选项新建的影片及其目标成员、可选详情链接和清单顺序一次事务提交。
- 支持取消、同一浏览器会话内的登录交接和有界幂等重试。
- 结果摘要能解释每部影片是复用、创建、已存在还是由用户决定。
- 清单详情页可按全局影片资源类型筛选导入后及既有影片，并能单独查看无资源影片。

### 3.2 非目标

- 不抓取封面、演员、标签、评分、样张等完整影片元数据。
- 不创建本地、直链、网页、Magnet 或 ED2K 影片资源。
- 不自动合并同番号影片。
- 不把跨媒体库复用的已有影片迁移或额外加入目标媒体库。
- 不用模型猜测目标媒体库或目标清单。
- 不允许外部页面指令改变冻结的目标或写入策略。
- 不在用户未明确开启“保存来源清单链接”时修改目标清单的相关链接；来源 URL 始终保存在导入任务审计中。
- 本期不为任意站点建立动态 Adapter 注册系统；只有实际出现第二个生产 Adapter 时再引入对应 seam。
- 真正无终点的 feed、无法观察终止条件或连续性的滚动列表、只存在于隐藏 API 且从不渲染到 DOM 的条目，以及跨域 iframe 清单不得标记为完成。

## 4. 用户体验

### 4.1 统一入口

在清单列表页 [PlaylistsPage.tsx](../src/renderer/src/pages/PlaylistsPage.tsx) 的 toolbar 增加“导入外部清单”次要按钮，保留“创建清单”为主要按钮。

在清单详情页 [PlaylistDetailPage.tsx](../src/renderer/src/pages/PlaylistDetailPage.tsx) 的 `DetailActionBar` 增加“从网页导入”。

两处打开同一个 `PlaylistImportModal`：

- 从清单列表进入时，默认目标为“新建清单”。
- 从清单详情进入时，默认目标为“追加到当前清单”，当前清单只读展示。
- 用户可以在统一弹窗中切换新建/追加；详情页入口切换后不隐式删除或修改当前清单。

### 4.2 开始表单

表单字段：

1. **外部清单 URL**：必填，公开 HTTP/HTTPS，不允许 URL 凭据。
2. **导入方式**：新建清单 / 追加到清单。
3. **清单**：
   - 新建：名称可选；留空时使用外部清单标题，仍为空时回退为“站点域名 · 日期”。
   - 追加：必须选择现有清单；从详情页进入时预选当前清单。
4. **目标媒体库**：必须明确选择一个 active 媒体库，不允许只依赖隐藏默认值。字段说明明确写成“新影片加入这里；跨库重复候选优先这里”，不能暗示清单属于该媒体库。
5. **自动创建无资源影片**：默认开启；关闭后跳过没有已有影片可复用的条目。
6. **保存详情页到相关链接**：默认开启；关闭后不向复用或新建影片写入外部详情 URL。
7. **保存来源清单链接**：默认关闭；开启后把本次外部清单页去重追加到目标清单的“相关链接”。

新清单名称留空时，Agent 只能从首个清单页明确的清单主标题、清单区域标题或可靠页面 metadata/document title 生成名称建议；不得根据影片内容、URL 或用户名编造。最终名称顺序为“用户输入 > Agent 名称建议 > 站点域名 · 日期”。

开始按钮文案为“开始导入”。旁边明确说明：

- 会读取外部清单的全部可见分页和可验证的虚拟滚动窗口。
- 已有影片会跨媒体库查找并可能直接复用。
- “自动创建无资源影片”默认开启；关闭后跳过未匹配条目。
- 不会下载或创建播放资源。
- “保存详情页到相关链接”默认开启；关闭后不写入。
- “保存来源清单链接”默认关闭；开启后写入目标清单且不重复添加已有链接。

点击开始即授权最终应用，不再对无歧义影片要求第二次整体确认。

### 4.3 运行中

弹窗开始后切换为任务视图。运行期间弹窗不可点击遮罩关闭，也不提供“后台运行”；用户必须保持软件和弹窗打开，或通过“终止任务”显式结束本次 Session。

进度按阶段展示：

- 枚举阶段：“已读取 4 页，发现 83 条，去重后 79 部”。
- 虚拟滚动阶段：“已读取 1 页、18 个滚动窗口，发现 83 条，去重后 79 部”。
- 总页数未知时使用不定进度，不伪造百分比。
- 身份阶段：“直接复用 51，待读详情 7，待用户选择 2，计划新建 19”。
- 应用阶段：“正在写入 79 部影片”。

`PlaylistImportProvider` 只维护当前弹窗对应的活动 Session，不在启动或页面刷新后自动接回旧任务。完成后在弹窗内提供“查看清单”。

### 4.4 身份选择

任务只在无法自动消歧时进入 `waiting_user`。身份选择面板按外部条目展示：

- 外部番号、标题、详情 URL 和详情页身份信号。
- 全局目录中的全部同番号候选，按影片 ID 去重并展示所属媒体库；目标媒体库候选带“优先库”标记。
- 候选的封面、标题、发行商、发行日期、相关链接、所属媒体库和资源摘要。
- 每项必须选择一个已有影片，或明确选择“创建新影片”。

本期不提供“跳过此影片”；目标是把全部唯一外部条目加入清单。用户不愿处理时可以取消整次任务，此时业务表保持不变。

### 4.5 完成摘要

完成摘要至少包含：

- 外部页面数、原始条目数、唯一详情 URL 数。
- 直接复用、详情页消歧复用、用户选择复用、新建无资源影片数量。
- 新加入清单、原本已在清单、跨库复用、目标媒体库新建成员和追加相关链接数量。
- 外部重复条目和多个外部条目最终指向同一影片的数量。
- 最终清单、目标媒体库以及复用影片的媒体库分布。

`completed` 必须表示全部唯一外部条目已经对应到影片并完成事务。不能用 `completed_with_errors` 掩盖遗漏。

### 4.6 清单详情资源类型筛选

清单详情的“影片”区块在排序控件前增加“资源筛选”按钮。按钮打开轻量 popover，选项复用现有资源类型和用户文案：本地文件、视频直链、网页链接、Magnet、ED2K、无资源。交互规则为：

- 允许多选，满足任一所选类型即可；未选择表示全部。
- `无资源` 表示该全局影片在所有媒体库中都没有任何 `video_resources`，不是“当前媒体库无资源”。
- 具体类型只要在任一媒体库存在一条对应资源即可命中；成员 hidden、媒体库 archived 或影片没有媒体库成员都不改变资源事实。
- STRM 不作为独立类型，按其实际目标 `kind`（direct/web/magnet/ed2k）筛选。
- 不依赖 `primary_resource_kind`；一个同时有 local 和 web 的影片能被任一条件命中，但在结果中只出现一次。

筛选是改变影片结果集的 shareable state，写入 URL 的既有 `resources` 参数。示例：`/playlists/4?q=待看&resources=web,none`。参数使用固定顺序 `local,direct,web,magnet,ed2k,none`；重复和非法值忽略，空选择删除参数。筛选变化使用 history replace，避免每次勾选都污染返回栈。

已应用条件只通过“资源筛选 · N”按钮计数反馈，不在影片网格上方额外显示 chip 条；用户在 popover 中调整或清空条件。清单头部继续显示清单总影片数；区块 count 在筛选时显示“匹配 N / 共 M 部”。清单本身为空与筛选结果为空必须区分：前者仍显示“清单内暂无影片”，后者显示“没有符合资源筛选的影片”并提供清除筛选动作。

popover 通过 `FloatingLayer` portaled 到详情滚动容器之外，使用 `role="dialog"` 和明确可访问名称；按钮维护 `aria-expanded/aria-controls`，Escape、点击外部和“完成”关闭后焦点返回触发按钮。控件沿用语义 token、标准小按钮和至少 24px 点击目标，不在 legacy 全局样式中新增页面专属颜色或尺寸。

打开影片详情、再打开演员详情以及逐层返回时完整保留 `q + resources`。从清单详情显式返回或删除后返回 `/playlists` 时只保留清单列表自己的 `q`，剥离详情专属 `resources`，避免筛选泄漏到清单列表或下一个清单。关闭影片详情时静默刷新清单详情投影；若用户在影片详情新增、删除或改变资源类型，当前筛选结果立即重新计算而 URL 不变。

## 5. 深 Module 和外部 Interface

UI、IPC 和测试只通过 `PlaylistImportModule` 的 Interface 使用功能：

```ts
export type PlaylistImportDestination =
  | {
      kind: 'create'
      requestedName?: string
    }
  | {
      kind: 'append'
      playlistId: number
    }

export interface PlaylistImportStartInput {
  idempotencyKey: string
  sourceUrl: string
  targetLibraryId: number
  destination: PlaylistImportDestination
  autoCreateUnmatchedVideos?: boolean
  saveDetailLinks?: boolean
  saveSourcePlaylistLink?: boolean
}

export type PlaylistImportControlCommand =
  | {
      kind: 'resume-browser'
      requestId: string
      idempotencyKey: string
    }
  | {
      kind: 'resolve-identities'
      expectedRevision: number
      idempotencyKey: string
      decisions: Array<{
        itemId: number
        choice:
          | { kind: 'existing'; videoId: number }
          | { kind: 'create' }
      }>
    }
  | {
      kind: 'cancel'
      idempotencyKey: string
    }

export interface PlaylistImportModule {
  start(input: PlaylistImportStartInput): Promise<PlaylistImportSnapshot>
  snapshot(runId?: string): PlaylistImportSnapshot | null
  control(runId: string, command: PlaylistImportControlCommand): Promise<PlaylistImportSnapshot>
  subscribe(listener: (event: { runId: string; revision: number }) => void): () => void
}
```

`start()` 在 Agent 运行被接受后立即返回，不等待全分页完成。`sourceUrl`、目标媒体库和目标清单策略在开始后冻结；Agent 工具不接收这些目标 ID。

### 5.1 产品快照

```ts
export type PlaylistImportPhase =
  | 'discovering-list'
  | 'resolving-identities'
  | 'waiting_user'
  | 'ready-to-apply'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface PlaylistImportSnapshot {
  runId: string
  revision: number
  cursor: number
  phase: PlaylistImportPhase
  summary: string
  frozenInput: {
    sourceUrl: string
    displayUrl: string
    sourceHost: string
    targetLibraryId: number
    targetLibraryNameAtStart: string
    destination: PlaylistImportDestination
    destinationPlaylistNameAtStart?: string
    policyVersion: 1
  }
  progress: {
    pagesRead: number
    scrollWindowsRead: number
    knownPageTotal?: number
    sourceItems: number
    uniqueItems: number
    directReuses: number
    detailPending: number
    userDecisionsPending: number
    plannedCreates: number
    appliedItems: number
  }
  attention?:
    | {
        kind: 'browser-handoff'
        requestId: string
        reason: 'login' | 'human_verification' | 'required_user_action'
        prompt: string
      }
    | {
        kind: 'identity-review'
        items: PlaylistImportIdentityReviewItem[]
      }
  outcome?: PlaylistImportOutcome
  error?: PlaylistImportError
}
```

快照只保存状态、计数和有限的待处理视图。页面和影片全集保存在专用表中，不放入 `agent_runs.product_state_json`。
`pagesRead` 只统计已经 sealed 的逻辑页；`scrollWindowsRead` 统计当前 Session 已 checkpoint 的虚拟渲染批次（包含首批）。重叠窗口中的旧 occurrence 不重复增加 `sourceItems`。

### 5.2 Interface 不变量

- 同一个 `idempotencyKey` 加相同输入返回同一 run；同 key 不同输入返回 `IDEMPOTENCY_KEY_REUSED`。
- 页面发现阶段不得写 `videos`、`library_video_memberships`、`playlist_video` 或 `video_links`。
- `ready-to-apply` 只在分页 frontier 为空、全部条目已作出影片决定后出现。
- `completed` 只在最终事务和任务 outcome 同时提交后出现。
- 对同一 Session 重复 checkpoint、身份决定、retry 和 apply 不产生重复数据。
- 新建模式在最终事务前不创建空清单。
- 追加模式不改变已有清单名称、说明、封面或已有影片顺序。

## 6. 运行结构和依赖

### 6.1 具体 Agent 用例

新增 `playlist-importer` Agent 定义、配置方案和工具包，不给现有只读 `LibraryCurator` 增加写权限。现有 Agent 平台决策要求新增具体用例、Definition/Profile、ToolPack 和 UI projector，而不复制 Pi runtime，参见 [ADR-0020](adr/0020-establish-agent-platform-seams-before-pi.md)。

首版可把 `playlist-importer` 的模型角色映射到现有 `library-curator` workload，避免增加一套模型设置；定义、产品状态和工具授权仍保持独立。

启动边界与 Agent 刮削保持一致：宿主只创建浏览器 Session、Agent run 和冻结工作项，然后立即分发首轮对话；首轮 prompt 要求 Agent 用通用 `browser open` 打开冻结来源 URL。来源页的网络导航、重定向识别、登录和人机验证不进入 `start` IPC 的临界路径，也不由清单领域预判。这样配置页在 runtime 接受首轮对话后即可切换到对话，后续页面处置统一由 Agent 根据 browser observation 决定；selector 检查点、frontier 和最终 apply 仍由宿主状态机约束。

建议授权：

```text
browser.interact
playlist-import.stage-page
playlist-import.stage-identity
```

用户点击“开始导入”已经授权宿主在完成条件满足后执行一次最终业务事务，不需要每页重复审批。最终 apply 不暴露为 Agent 工具；Agent 只能暂存页面和详情身份。ToolHost 仍负责 allowlist、资源锁、ledger、参数脱敏和幂等调用。

### 6.2 依赖分类

- **In-process**：番号规范化、URL 规范化、分页 frontier、去重、状态 reducer、匹配决策。
- **Local-substitutable**：SQLite、Agent run store、页面/条目暂存和最终事务；接口测试直接使用内存 SQLite。
- **True external**：外部网站和浏览器、模型 provider；生产使用现有 browser/Pi Adapter，测试使用 scripted browser 和 runtime fake。

浏览器是实际 seam，因为至少存在生产 browser Adapter 和测试 page-graph Adapter。SQLite 不需要额外暴露 Repository port；它作为 Module 内部依赖直接使用真实内存数据库测试。

### 6.3 总体状态机

```text
start
  │
  ▼
discovering-list ──browser handoff──▶ waiting_user
  │                                      │
  │ frontier empty                       └─resume-browser─┐
  ▼                                                      │
resolving-identities ◀────────────────────────────────────┘
  │
  ├─remaining ambiguity──▶ waiting_user ─resolve-identities─┐
  │                                                         │
  └─all resolved ◀───────────────────────────────────────────┘
  │
  ▼
ready-to-apply → applying → completed
       │              │
       └──────────────┴──failure→ failed

任何非终态 ─cancel→ cancelled
```

## 7. Agent 工具包和页面级检查点

Agent 不获得 `video_create`、`playlist_add_video` 或任意 SQL 工具。生产 ToolPack 提供：

1. `browser`：提供 snapshot/find/html/evaluate/wait/status/read-section/open/click/fill/press/scroll/handoff。Agent 根据当前页面事实决定同站点导航、页面交互和用户 handoff；浏览器 Adapter 负责站点边界、动作参数和会话预算。
2. `checkpoint_playlist_page`：提交 selector 合同；宿主完整固化普通页，或初始化一个加载更多/虚拟滚动逻辑页。
3. `advance_playlist_page`：只允许从已固化状态进入已记录的下一页、点击“加载更多”，或执行一次“滚动、等待、提取、落盘”原子步骤。
4. `open_playlist_item_detail`：只允许打开一个已暂存且需要详情消歧的 URL。
5. `checkpoint_playlist_detail`：提交当前详情页明确展示的强弱身份信号和证据；候选 ID 和匹配结论由宿主重算。

没有独立 `finish` 工具。每次页面/详情 checkpoint 和 advance 返回前，宿主都会机械检查 frontier、动态页终点、声明总数和身份状态；全部满足时自动进入单事务 apply，否则返回唯一的下一工作项或具体 blocker。

目标清单、目标媒体库和写入策略不出现在工具参数中，全部从冻结 run 读取，防止网页 prompt injection 篡改目标。

### 7.1 清单页检查点

普通清单页必须在离开前完整 checkpoint。虚拟清单页先 checkpoint 首个渲染窗口并冻结提取计划；此后每次 `advance_playlist_page` 都先确认上一窗口已落盘，再在同一宿主操作内滚动、等待稳定、提取并落盘新窗口，Agent 无法连续滚动而跳过中间窗口。工具参数轮廓：

```ts
type TerminalOrLinkAdvance =
  | {
      kind: 'terminal'
      reason:
        | 'disabled-next'
        | 'explicit-last-page'
        | 'no-pagination-container-after-full-dom-check'
      selector: string // 宿主在活 DOM 中验证禁用控件、末页标记或分页容器不存在
    }
  | { kind: 'terminal'; reason: 'known-total-reached' }
  | { kind: 'next-link'; selector: string }
  | { kind: 'numbered-links'; selector: string }
type PageAdvance =
  | TerminalOrLinkAdvance
  | {
      kind: 'load-more'
      selector: string
      afterExhausted:
        | { kind: 'terminal'; reason: 'load-more-control-exhausted' }
        | Exclude<TerminalOrLinkAdvance, { kind: 'terminal' }>
    }

interface PageCheckpointEvidence {
  evidenceRefs: string[]
  extraction: {
    candidateSelector: string
    detailLink: {
      selector: string
      attribute?: string // 默认 href
    }
    code?: {
      selector?: string // 省略时读取 candidate 文本
      attribute?: string
      pattern?: string
    }
    title?: {
      selector?: string
      attribute?: string
    }
  }
  declaredTotalItems?: number
  declaredTotalPages?: number
}

type CheckpointPageInput =
  | (PageCheckpointEvidence & {
      kind: 'static-page'
      advance: PageAdvance
    })
  | (PageCheckpointEvidence & {
      kind: 'virtual-page-start'
      enumeration: {
        containerSelector?: string // 省略时为 document.scrollingElement
        itemPosition:
          | { kind: 'aria-posinset' }
          | { kind: 'attribute'; name: string; base: 0 | 1 }
      }
      advance: PageAdvance
    })
  | (PageCheckpointEvidence & {
      kind: 'load-more-page-start'
      advance: PageAdvance
    })
```

`PlaylistImportAgentRunDriver` 通过当前 browser lease 在活文档上执行冻结 selector，不能只相信模型手工抄写的候选数组：

- 枚举全部候选容器。
- 每个容器必须得到一个合法详情 URL。
- 相对 href 按当前 `document.baseURI` 解析。
- 保存原始番号/标题和规范化番号。
- 去 fragment 后生成规范详情 URL。
- 保存当前 URL、document/view revision、内容 hash、候选数和证据引用；虚拟窗口还保存滚动 metrics、渲染顺序和连续性证据。
- 任何候选无法解析时，整个页面检查点失败，Agent 必须在当前页修正 selector。

`pageKey`、document/view revision 和滚动状态都由宿主从当前 lease 与 evidence 计算，不接受 Agent 自报。checkpoint 还必须校验：document revision 仍属于当前页面，view revision 仍对应当前渲染窗口；evidence ref 位于本 run workspace 且内容 hash 有效；artifact 已完整，或所有被省略 section 已通过 `read-section` 读完。这里的“artifact 完整”只证明 observation 完整，不能证明通用 observation 已枚举 DOM 中的全部候选，所以最终条目数必须来自宿主对冻结 selector 的活页面全量提取。

这是页面级检查点，不是按字段渐进提交：一次普通清单页 checkpoint 固化当前稳定 DOM 中的全部候选和分页证据；虚拟页从首窗口开始，以宿主原子步骤固化每个渲染窗口的位置/重叠证据和滚动状态，最终再 seal 整个逻辑页；一次详情页 identity checkpoint 固化当前页面全部明确身份事实。不得把番号、标题、发行商、日期拆成多次提交后再回页补齐。

静态页 checkpoint 直接封存当前逻辑页。加载更多页和虚拟页 start 会在当前连接的 TEMP Session 中留下唯一 open dynamic page；每次 `advance_playlist_page` 只读取该 Session 状态并原子写入下一批，加载按钮消失或虚拟列表连续两次稳定到达底部时自动 seal。Agent 不接收可伪造的 page/scroll token、像素或批次号；这些值只来自冻结合同和宿主状态。

通用 browser 是 Agent 的页面控制面：Agent 可以根据页面事实关闭遮挡、完成安全的同站点导航、识别登录或验证页并立即 handoff，也可以在用户完成操作后自行返回冻结工作项。宿主不再维护登录页、验证页、首页等站点语义分支，也不提供专用“恢复工作项”工具。不可逆的业务边界仍由领域工具掌握：开始任务时首个清单工作项被认领为 `in-flight`；后续 pending 页面即使已由通用 browser 打开，也必须先由 `advance_playlist_page` 按 frontier 原子认领，才能提交 selector checkpoint。清单候选只能由当前冻结工作项上的有效证据和 selector checkpoint 固化，动态分页只能由 `advance_playlist_page` 原子推进，详情身份和最终写入继续由状态机校验。因此 Agent 可以自由处理页面，但不能凭通用 browser 输出绕过完整性与原子提交规则。

### 7.2 分页 frontier

逻辑页 seal 后，把所有可见的下一页 URL或一个“加载更多”动作加入 run 的 frontier；虚拟页尚未 seal 时则保留一个只允许单步滚动的 frontier：

- `next-link` 保存单个未访问 URL。
- `numbered-links` 保存全部未访问 URL，按页面声明顺序遍历。
- `load-more` 保存来源检查点对应的待执行动作；点击后 URL 和 document revision 都可以不变，但候选 digest 或分页 digest 必须变化并形成新 page key，否则记录 `no-progress`。
- `scroll` 保存当前虚拟页、滚动容器指纹、上一批次、滚动 metrics 和宿主签名 token；每次只下移半个 viewport，并在返回 Agent 前自动 checkpoint 新渲染窗口。
- `terminal` 必须携带可验证的终止原因。`disabled-next`、`explicit-last-page` 和 `no-pagination-container-after-full-dom-check` 还必须给出对应 selector，由宿主在活 DOM 中机械验证；`known-total-reached` 必须同时提交声明总页数或总条目数，并由最终总数核对验证。不能只因为 Agent 没看到 next 就假设完成；无分页控件时也要由宿主对完整 DOM 检查分页容器确实不存在。“加载更多”只有在宿主确认冻结的控件已耗尽后才接受 `load-more-control-exhausted`。

frontier 使用规范 URL、候选 digest、分页 digest 和内容 hash 检测重复与循环。以下任一条件存在时自动完成检查必须拒绝进入 apply：

- frontier 还有未访问页面、待执行加载动作或未完成滚动动作。
- 当前 document/view revision 未 checkpoint，或虚拟逻辑页尚未 seal。
- 声明总页数和已读页数不一致。
- 声明总条目数和已观察条目数不一致。
- 相邻虚拟窗口无法证明连续，或滚动终点尚未得到证明。
- 页面证据缺失或候选解析不完整。
- 分页循环、越过授权站点或达到安全上限。

### 7.3 虚拟滚动完整性协议

虚拟列表会回收已离开 viewport 的 DOM 节点，因此“最后一次读取完整 DOM”没有意义。V1 把一个 URL 对应的逻辑页与其中多个短生命周期渲染窗口分开：

1. 首次打开逻辑页必须位于滚动起点；宿主记录容器指纹、初始 metrics 和第 0 批全部候选，冻结候选/详情链接选择器及位置策略。
2. 只有第 N 批已事务提交后，宿主状态机才允许下一次 advance。一次 advance 固定下移半个 viewport，等待两个 animation frame，并在有界时间内确认滚动 metrics、冻结候选 digest、分页链接及 load-more 可用状态经过连续静默窗口保持稳定，再从活 DOM 同步读取 metrics 与第 N+1 批全部候选并事务提交；首个新增候选不代表动态扩展完成，模型不能指定像素、跳到底部或在两次 checkpoint 之间再次滚动。
3. V1 只接受 `aria-posinset` 或站点稳定的绝对位置属性形成 `sourceOccurrenceKey`。自定义属性必须同时冻结 `base: 0 | 1`，宿主统一换算为从 0 开始的绝对位置；没有绝对位置时直接返回 `VIRTUAL_LIST_POSITION_MISSING/UNSUPPORTED_LIST_STRUCTURE`，不通过启发式重叠猜测顺序。
4. 重叠候选只是渲染证据，不重复增加 `sourceItems`。同一详情 URL 在不同稳定位置出现时保留两个逻辑 occurrence，但仍只生成一个按规范详情 URL 去重的影片工作项。
5. 宿主只有在声明总数与连续 occurrence 已核对，并且连续两次受控滚动都满足 `moved=false && atEnd=true`、没有新 occurrence 时才自动 seal。一次 `atEnd` 不是完成证据，因为懒加载可能随后扩展高度。
6. 下一页和编号分页只在逻辑页 seal 后进入 frontier；`load-more` 是扩展当前逻辑页的动作，因此连续两次稳定到底但冻结按钮仍可用时，宿主先记录该终点证据，下一次 advance 点击按钮并记录唯一 operation key，再从扩展后的窗口继续受控滚动。只有按钮已由宿主证明耗尽且再次满足稳定终点后才 seal。这样虚拟列表可以与下一页、编号分页和 load-more 组合，不能把 `virtual-scroll` 与这些分页方式做成互斥枚举。

同一 Session 内发生可重试错误时，宿主丢弃当前未封存动态页及其下游 frontier，从该页入口 URL 顶部重新读取；已经封存的上游逻辑页继续有效。不会为软件退出保存或重放 scrollTop、viewport、滚动链及 load-more 点击链。真正无终点的 feed、无法得到稳定绝对位置或终点证明的列表、canvas/自定义 wheel 列表、跨域 iframe，以及只在隐藏 API 中出现而从不进入 DOM 的条目仍明确失败；达到页数、批次数、条目数或运行时间预算时返回 `LIMIT_REACHED`，不得以截断结果完成。

### 7.4 阶段顺序

Agent system prompt 和宿主状态共同约束：

- `discovering-list` 期间不能调用 `open_playlist_item_detail`。
- frontier 清空并完成枚举后，列表页 checkpoint 变成不可变快照。
- `resolving-identities` 期间不得重新打开清单页。
- 只有详情证据或用户决定暴露具体 blocker 时才处理对应 item。
- 第一次业务写入只能发生在全部身份决定完成之后。

这使单当前页面浏览器不需要在清单页和详情页之间反复导航。

Agent 的自然语言“完成”或 runtime `settled` 不是产品完成条件。宿主必须确认枚举已 seal、frontier 无 pending/in-flight、声明总数已核对、当前页已 checkpoint、每个唯一 item 已计划 reuse/create、不存在待处理详情、用户决定或 handoff，才允许进入 `ready-to-apply`；否则返回结构化 blocker 并保持任务未完成。

## 8. 候选去重和来源顺序

清单页最小候选为：

```ts
interface ExternalPlaylistOccurrence {
  sourceOccurrenceKey: string
  detailUrl: string
  normalizedDetailUrl: string
  rawCode?: string
  normalizedCode?: string
  title?: string
  sourcePosition: number
  pageKey: string
  evidenceRefs: string[]
}
```

规则：

- 来源逻辑 occurrence、虚拟渲染批次和唯一影片工作项是三个不同概念。`sourceItems` 统计已证明的来源 occurrence；同一 occurrence 在相邻渲染窗口重复出现不重复计数。
- 同一 run 内相同 `normalizedDetailUrl` 只创建一个 `playlist_import_items` 工作项，并用首次来源位置排序；其它稳定位置仍保留 `playlist_import_page_items` occurrence 并计入外部重复。
- 虚拟列表没有稳定绝对位置时明确失败；`overlap` position mode 仅用于“加载更多”完整 DOM 批次，不用于推断虚拟窗口顺序。
- 不按番号去重；同番号可以代表不同影片。
- 不同详情 URL 最终解析到同一影片时，清单只加入一次，但每个不同详情 URL 都可以追加为该影片的相关链接。
- 新建清单按首次外部出现顺序写 `playlist_video.position = 0..N-1`。
- 追加清单保留现有 position，新影片从当前最大 position 后按外部首次出现顺序追加。
- 已在目标清单的影片不重排。

## 9. 影片匹配策略

### 9.1 全局完全匹配番号

使用现有 `normalizeVideoCode()` 规则：移除首尾空白并转大写；连字符、下划线、内部空格和尾缀保持不变。不能使用包含匹配、移除分隔符或模糊匹配。

候选查询直接作用于全局 `videos`，不按媒体库过滤：

```sql
SELECT video.*
FROM videos video
WHERE upper(trim(video.code)) = @normalizedCode
ORDER BY video.id;
```

随后批量读取每个候选的媒体库成员及媒体库状态，用于 UI 展示和目标媒体库决胜，但不改变候选集合。候选计数按不同 `video.id` 计算；同一影片同时属于多个媒体库仍只算一条候选。`inTargetLibrary` 按成员关系是否存在判断，包括 hidden 成员；决胜后也不改变 hidden/pin。没有任何媒体库成员但因清单引用等原因仍保留的全局影片也参与匹配，避免再次创建相同目录记录。

### 9.2 决策算法

```ts
function planItem(item, targetLibraryId): Resolution {
  if (!item.normalizedCode) return needsDetail('code-missing')

  const candidates = listGlobalVideosByNormalizedCode(item.normalizedCode)

  if (candidates.length === 0) {
    return createResourceLessVideoInTargetLibrary(item, targetLibraryId)
  }

  if (candidates.length === 1) {
    return reuse(candidates[0], 'unique-exact-code-in-global-catalog')
  }

  return needsDetail('multiple-global-exact-code-candidates', candidates)
}
```

唯一全局候选直接复用其影片 ID，不新增目标媒体库成员、不改变隐藏状态和现有资源。多个全局候选始终先打开详情页，不能仅凭目标媒体库提前跳过详情。

这是冻结为 `policyVersion: 1` 的规则。后续修改规则必须增加版本，旧 run 继续使用启动时版本。

### 9.3 多候选详情页消歧和目标媒体库决胜

详情页只采集用于身份判断的字段，不把它们当作本次元数据更新写入现有影片：

- 详情页规范 URL。
- 页面明确展示的规范化番号。
- 站点原生 external ID（如果存在）。
- 发行商名称/页面实体链接。
- 发行日期。
- 原始标题或标题。

先在全部全局候选之间应用强信号：

1. 详情 URL 与一个候选的 `video_links.normalized_url` 唯一相等。
2. 同一站点的 `video_sources.external_code` 或 `video_sources.url` 与一个候选唯一相等。
3. 页面发行商能解析到已有发行商实体，且“发行商实体 + 规范化番号 + 发行日期”与一个候选完整业务身份唯一相等。

强信号唯一命中时直接复用，即使该影片只属于其它媒体库。目标媒体库不能覆盖唯一强信号。

如果强信号没有冲突但仍留下多个合理候选，再计算其中属于目标媒体库的不同影片 ID：

- 恰好 1 条：复用该影片，`resolution_kind = 'target-library-tiebreak'`。
- 0 条或多于 1 条：进入用户选择。

同一影片 ID 同时属于多个媒体库不构成歧义。标题只能作为用户辨识信息或强信号相同后的辅助校验，不能单独自动决定身份。候选缺少字段不视为矛盾，不能通过“其他候选没有资料”排除它。

以下情况不能使用目标媒体库决胜，必须进入用户选择：

- 不同强信号分别指向不同候选。
- 列表页番号和详情页番号规范化后不同。
- 页面身份字段互相矛盾或证据不完整，无法定义仍合理的候选集合。
- 目标媒体库中仍有多个合理候选。
- 合理候选都不在目标媒体库。

用户选择面向全部全局候选，可以选择任一已有影片或明确创建新影片；选择新建时才在目标媒体库创建成员。决定写入独立记录并带 `expectedItemRevision`。目录或成员关系变化导致候选快照、强信号结果或目标媒体库决胜失效时返回 `IDENTITY_REVIEW_STALE`，不能静默采用旧决定。

### 9.4 全局目录为 0 条

列表页有可靠番号且全局目录没有完全匹配时，直接计划在目标媒体库创建身份待定影片。创建字段只包含：

- 规范化番号。
- 页面明确展示的标题（可空）。
- `scraped_status = 0`。

新影片获得目标媒体库的可见成员，但没有任何 `video_resources`。其他完整元数据留给现有刮削或 Agent 元数据采集流程。

如果列表页没有可靠番号，则先打开详情页获取番号，再按同一全局算法处理。详情页仍无可靠番号时进入用户选择，只提供：

- 明确在目标媒体库创建无番号的身份待定影片；或
- 取消整次任务。

### 9.5 跨媒体库复用边界

- 复用已有影片只写清单引用和详情相关链接，不创建目标媒体库成员，不移动资源，不改变原媒体库成员状态。
- 用户选择的目标媒体库仅承接 `planned-create/user-create`，并为详情后剩余的跨库重复记录提供决胜偏好。
- 多条记录不会因为目标媒体库决胜而自动合并；未选记录保持不变。
- 同一全局影片已经属于多个媒体库时仍复用同一个影片 ID，不选择或复制某一条成员关系。
- 清单读取以 `playlist_video.video_id` 为事实，不因当前媒体库切换而过滤影片。

## 10. 前台 Session 临时模型

当前数据库版本在 [migrations.ts](../src/main/db/migrations.ts) 中为 V14。外部清单导入暂存表不属于发布 schema，也不由 V13 → V14 迁移创建；`PlaylistImportRepository` 在当前 SQLite 连接中创建 TEMP 表，连接关闭后全部消失。下面保留的字段结构用于说明 Session 内约束，实际定义以 [schema.ts](../src/main/db/schema.ts) 的 `PLAYLIST_IMPORT_SESSION_SCHEMA_SQL` 为准：所有表均为 `CREATE TEMP TABLE`，不引用持久 `agent_runs`、`playlists`、`videos` 外键，另有 `playlist_import_session_events` 保存本次 Session 的页面/交接幂等事件。

### 10.1 `playlist_import_jobs`

```sql
CREATE TEMP TABLE playlist_import_jobs (
    run_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    policy_version INTEGER NOT NULL DEFAULT 1,
    phase TEXT NOT NULL CHECK(phase IN (
      'discovering-list', 'resolving-identities', 'waiting_user',
      'ready-to-apply', 'applying', 'completed', 'failed', 'cancelled'
    )),
    revision INTEGER NOT NULL DEFAULT 1,
    source_url TEXT NOT NULL,
    normalized_source_url TEXT NOT NULL,
    source_host TEXT NOT NULL,
    destination_kind TEXT NOT NULL CHECK(destination_kind IN ('create', 'append')),
    requested_playlist_id INTEGER,
    requested_playlist_name TEXT,
    agent_suggested_playlist_name TEXT,
    resolved_playlist_id INTEGER,
    target_library_id INTEGER NOT NULL,
    target_library_name_snapshot TEXT NOT NULL,
    auto_create_unmatched_videos INTEGER NOT NULL DEFAULT 1,
    save_detail_links INTEGER NOT NULL DEFAULT 1,
    save_source_playlist_link INTEGER NOT NULL DEFAULT 0,
    counters_json TEXT NOT NULL DEFAULT '{}',
    apply_idempotency_key TEXT,
    outcome_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    committed_at TEXT
);
```

`requested_playlist_id` 和 `target_library_id` 是本次 Session 的冻结输入；最终应用时重新校验实际目标。`requested_playlist_name` 保留用户冻结输入，`agent_suggested_playlist_name` 保留首页证据产生的建议，两者不混用。`playlist_import_jobs.phase` 是当前前台任务的事实源，Agent 平台记录只用于通用运行活动展示，不能恢复导入产品状态。

### 10.2 `playlist_import_pages`

```sql
CREATE TEMP TABLE playlist_import_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    page_key TEXT NOT NULL,
    page_order INTEGER NOT NULL,
    page_url TEXT NOT NULL,
    normalized_page_url TEXT NOT NULL,
    document_revision TEXT NOT NULL,
    initial_view_revision TEXT NOT NULL,
    enumeration_kind TEXT NOT NULL CHECK(enumeration_kind IN (
      'static-dom', 'virtual-scroll', 'load-more'
    )),
    enumeration_status TEXT NOT NULL CHECK(enumeration_status IN ('open', 'sealed')),
    container_contract_json TEXT,
    position_mode TEXT CHECK(position_mode IS NULL OR position_mode IN (
      'aria-posinset', 'attribute', 'overlap'
    )),
    sequence_digest TEXT,
    content_hash TEXT,
    evidence_ref TEXT NOT NULL,
    advance_json TEXT,
    observed_item_count INTEGER NOT NULL DEFAULT 0,
    declared_total_items INTEGER,
    declared_total_pages INTEGER,
    checkpointed_at TEXT NOT NULL,
    sealed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES playlist_import_jobs(run_id) ON DELETE CASCADE,
    UNIQUE (run_id, page_key),
    UNIQUE (run_id, page_order)
);

```

`playlist_import_pages` 一行表示一个逻辑页，而不是一个短生命周期 viewport。静态页插入时直接 sealed；虚拟页先以 open 状态插入，只有连续性、终点和总数核对都通过后才写 `sequence_digest/content_hash/advance_json/sealed_at`。`page_key` 不能依赖随滚动窗口变化的 digest；宿主固定计算：

```text
pageKey = sha256(
  normalizedPageUrl
  + entryFrontierCanonicalKey
)
```

因此，同 URL 的“加载更多”状态仍由不同的入口 frontier key 形成不同逻辑页；候选、累计序列和分页 digest 用于幂等与变化检测，不把每个虚拟窗口误建成 page。

### 10.3 `playlist_import_scroll_batches`

```sql
CREATE TEMP TABLE playlist_import_scroll_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    batch_order INTEGER NOT NULL,
    operation_key TEXT NOT NULL,
    view_revision TEXT NOT NULL,
    container_fingerprint TEXT NOT NULL,
    scroll_top REAL NOT NULL,
    scroll_height REAL NOT NULL,
    client_height REAL NOT NULL,
    ordered_occurrence_keys_json TEXT NOT NULL,
    rendered_item_count INTEGER NOT NULL,
    new_occurrence_count INTEGER NOT NULL,
    batch_digest TEXT NOT NULL,
    accumulated_sequence_digest TEXT NOT NULL,
    first_anchor_key TEXT,
    last_anchor_key TEXT,
    at_start INTEGER NOT NULL CHECK(at_start IN (0, 1)),
    at_end INTEGER NOT NULL CHECK(at_end IN (0, 1)),
    terminal_probe_count INTEGER NOT NULL DEFAULT 0,
    evidence_ref TEXT NOT NULL,
    checkpointed_at TEXT NOT NULL,
    FOREIGN KEY (page_id) REFERENCES playlist_import_pages(id) ON DELETE CASCADE,
    UNIQUE (page_id, batch_order),
    UNIQUE (page_id, operation_key)
);

```

批次表保存当前 Session 的渲染窗口证据；它不是来源条目计数表，也不是跨进程恢复锚点。`view_revision` 由 browser 宿主生成，`batch_digest` 和 `accumulated_sequence_digest` 由 Import Adapter 根据冻结提取计划生成。相邻窗口重叠的 occurrence key 会重复出现在 JSON 中，但只在 `playlist_import_page_items` 中落一条逻辑 occurrence。

### 10.4 `playlist_import_frontier`

```sql
CREATE TEMP TABLE playlist_import_frontier (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    source_page_id INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('url', 'click', 'scroll')),
    target_json TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    order_hint INTEGER,
    status TEXT NOT NULL CHECK(status IN (
      'pending', 'in-flight', 'checkpointed', 'no-progress', 'denied'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    replay_chain_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES playlist_import_jobs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (source_page_id) REFERENCES playlist_import_pages(id) ON DELETE CASCADE,
    UNIQUE (run_id, canonical_key)
);

```

URL 分页按规范 URL 去重；`load-more` 按来源检查点和动作指纹去重；`scroll` 按逻辑页、已提交批次和容器指纹去重。每次只允许一个 `in-flight` 工作项。`target_json`、签名 URL、点击 selector 和滚动参数只留在宿主 Session，Agent 只收到不透明 ref。同一 Session 重试从当前未封存页起点重新开始，不重放旧的加载更多或滚动动作链。

### 10.5 `playlist_import_items`

```sql
CREATE TEMP TABLE playlist_import_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    first_page_id INTEGER NOT NULL,
    source_position INTEGER NOT NULL,
    raw_code TEXT,
    normalized_code TEXT,
    title TEXT,
    detail_url TEXT NOT NULL,
    normalized_detail_url TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'discovered', 'needs-detail', 'needs-user',
      'planned-reuse', 'planned-create', 'applied', 'failed'
    )),
    revision INTEGER NOT NULL DEFAULT 1,
    candidate_snapshot_json TEXT,
    detail_identity_json TEXT,
    detail_evidence_ref TEXT,
    resolution_kind TEXT CHECK(resolution_kind IS NULL OR resolution_kind IN (
      'direct-code', 'detail-url', 'source-id', 'business-identity',
      'target-library-tiebreak', 'user-existing', 'user-create', 'create-no-match'
    )),
    resolved_video_id INTEGER,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES playlist_import_jobs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (first_page_id) REFERENCES playlist_import_pages(id) ON DELETE CASCADE,
    UNIQUE (run_id, normalized_detail_url),
    UNIQUE (run_id, source_position)
);

```

### 10.6 `playlist_import_page_items`

```sql
CREATE TEMP TABLE playlist_import_page_items (
    page_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    source_occurrence_key TEXT NOT NULL,
    source_position INTEGER NOT NULL,
    page_position INTEGER NOT NULL,
    raw_evidence_json TEXT NOT NULL,
    PRIMARY KEY (page_id, source_occurrence_key),
    FOREIGN KEY (page_id) REFERENCES playlist_import_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES playlist_import_items(id) ON DELETE CASCADE,
    UNIQUE (page_id, page_position)
);

```

该表保存来源清单中的逻辑 occurrence，而 `playlist_import_items` 保存 run 内按规范详情 URL 去重后的工作项。虚拟列表的稳定绝对位置直接形成 occurrence key；加载更多每批重新读取完整 DOM，并按稳定前缀追加新 occurrence。静态页 checkpoint 在同一事务内写 page、全部 occurrence、首次出现的 item 和 frontier；动态页则每批增量写 batch、新 occurrence和首次出现的 item，seal 时强制 `observed_item_count = 当前逻辑页 occurrence 数`。这样窗口重叠不会膨胀 `sourceItems`，同 URL 在两个显式位置出现又不会被误删。

### 10.7 `playlist_import_decisions`

```sql
CREATE TEMP TABLE playlist_import_decisions (
    item_id INTEGER PRIMARY KEY,
    expected_item_revision INTEGER NOT NULL,
    choice_kind TEXT NOT NULL CHECK(choice_kind IN ('existing', 'create')),
    chosen_video_id INTEGER,
    decided_at TEXT NOT NULL,
    FOREIGN KEY (item_id) REFERENCES playlist_import_items(id) ON DELETE CASCADE,
    CHECK(
      (choice_kind = 'existing' AND chosen_video_id IS NOT NULL)
      OR (choice_kind = 'create' AND chosen_video_id IS NULL)
    )
);
```

`candidate_snapshot_json` 保存每个全局候选影片 ID、身份摘要、媒体库成员 ID/状态以及是否属于目标媒体库；同一影片的多个成员不复制成多个候选。候选快照、逐页出现记录和用户决定分开保存，使完整性证明、同一 Session 重试和 stale 检测都不依赖模型 transcript。

## 11. 最终应用事务

新增内部 `PlaylistImportMutationRepository.apply(runId)`，在一个 SQLite transaction 中完成，不让 Agent 循环调用现有浅入口。

事务步骤：

1. 读取 job，要求 `phase = 'ready-to-apply'`，校验 `policy_version`。
2. 校验目标媒体库仍存在且为 active。
3. 新建模式：
   - 计算清单名称：用户输入 > Agent 从首页证据产生的名称建议 > “域名 · 日期”。
   - 此时才插入 `playlists`。
4. 追加模式：校验目标清单仍存在；名称、简介和封面保持不变。
5. “保存来源清单链接”开启时，把冻结的规范化外部清单 URL 追加到 `playlist_links`；已存在时不覆盖用户标签或顺序，关闭时不修改清单相关链接。
6. 按 `source_position` 重新校验每个 item 的决定及候选 revision。
7. `planned-create/user-create`：插入 `videos(code, title, scraped_status=0)`，不插入 `video_resources`；同时在目标媒体库创建 `is_hidden=0/is_pinned=0/added_via='manual'` 的成员。
8. `planned-reuse`：校验全局影片仍存在且原解析仍成立；不新增、迁移、隐藏或恢复任何媒体库成员。直接番号策略要确认它仍是唯一全局完全匹配，目标媒体库决胜要确认合理候选中仍恰好一条属于目标媒体库。
9. 追加详情 URL 到 `video_links`：
   - 使用规范 URL 幂等。
   - 已存在时不覆盖用户标签或顺序。
   - 新链接 label 使用来源站点显示名，追加到当前最大 position 后。
10. 写 `playlist_video`：
    - 新建清单按外部顺序从 0 开始。
    - 追加清单只追加新 videoId，保留已有 position。
11. 更新 item 为 `applied`，写 outcome、`resolved_playlist_id`、`committed_at` 和 job `completed`。
12. 同一事务更新 Agent 产品状态所需的领域结果；事务提交后再发送 renderer event。

现有约束可以作为最终幂等底座：

- 媒体库成员主键 `(library_id, video_id)`。
- 清单成员主键 `(playlist_id, video_id)`。
- 影片相关链接唯一键 `(video_id, normalized_url)`。
- 清单相关链接唯一键 `(playlist_id, normalized_url)`。

但不能原样循环使用：

- [playlistRepo.ts](../src/main/db/playlistRepo.ts) 的 `addVideoToPlaylist()` 每次单独计算 position。
- [relatedLinkStore.ts](../src/main/db/relatedLinkStore.ts) 的 `replaceRelatedLinks()` 会先删除全部链接。

因此需要批量事务内部的 prepared statements和一个“append related link if absent”；媒体库成员插入只服务本次新建影片，不对复用影片执行 upsert。

### 11.1 清单引用保护

导入事务中的 `playlist_video` 与新建影片及其目标媒体库成员一起提交。事务外不会出现“已创建无资源影片但尚未建立清单引用”的可观察中间态；跨库复用只增加清单关系，不改变来源媒体库。

两个自动清理入口必须统一增加清单引用排除条件。媒体库成员查询使用：

```sql
AND NOT EXISTS (
  SELECT 1
  FROM playlist_video playlist_item
  WHERE playlist_item.video_id = membership.video_id
)
```

全局影片查询使用同一条件并关联 `v.id`：

```sql
AND NOT EXISTS (
  SELECT 1
  FROM playlist_video playlist_item
  WHERE playlist_item.video_id = v.id
)
```

具体落点：

- [libraryMembershipRepo.ts](../src/main/db/libraryMembershipRepo.ts) 的 `removeResourceLessMemberships()`：候选查询和最终 `DELETE` 都排除被清单引用的影片，避免全量扫描移除其任一媒体库成员。
- [videoRepo.ts](../src/main/db/videoRepo.ts) 的 `purgeResourceLessVideos()`：候选选择必须放入删除事务，并排除被清单引用的影片，避免全局清理级联删除 `playlist_video`。

现有 `idx_playlist_video_video_id` 已支持该反向存在性查询，不需要新增 retention 字段、索引或迁移。影片从最后一个清单移除后，如果仍然没有资源且没有其它 pin 保护，就会在下一次适用的自动清理中恢复为可清理对象。显式删除影片或媒体库成员不使用这条自动清理过滤器。

### 11.2 清单全局读取

现有 [playlistRepo.ts](../src/main/db/playlistRepo.ts) 的清单计数、预览封面和详情查询都会要求影片至少存在一条 active + visible 媒体库成员。该过滤与“清单直接引用全局影片 ID”冲突，也会让仍受清单保护但已被用户显式移除全部媒体库成员的影片消失在清单 UI。

实施时统一改为：

- `listPlaylists()` 的 `video_count` 直接统计 `playlist_video`，不按媒体库成员过滤。
- 默认预览封面按清单顺序从被引用影片中选择，不按媒体库状态过滤。
- `getPlaylistDetail()` 直接通过 `playlist_video JOIN videos` 返回全部引用影片。
- 影片卡片的资源摘要继续聚合该全局影片的全部资源；实际播放、打开文件或资源维护仍要求用户界面提供明确的媒体库/资源作用域。
- 无资源、无媒体库成员但仍被清单引用的影片显示为正常的无资源影片，而不是从计数和详情中隐藏。

这不是为清单新增媒体库字段，而是移除现有 read model 中隐含的媒体库过滤，使读取语义与既有全局 `playlist_video(video_id)` 关系一致。

### 11.3 清单详情资源类型筛选

按 11.2 调整后的 `getPlaylistDetail()` 会一次返回清单全部引用影片；现有 `videoListSelectExtras()` 已能为每部影片投影全局去重后的 `resource_kinds`。V1 在 renderer 派生筛选结果，不扩展 `playlist:get` 的 IPC/preload Interface，也不在 SQL 中重复一套筛选合同：

```ts
function matchesPlaylistResourceFilters(
  video: Video,
  filters: VideoResourceFilter[]
): boolean {
  if (filters.length === 0) return true
  const kinds = video.resource_kinds ?? []
  return filters.some((filter) =>
    filter === 'none' ? kinds.length === 0 : kinds.includes(filter)
  )
}
```

`detail.videos` 始终是未筛选全集，`visibleVideos` 用 `useMemo` 派生并保留后端现有排序顺序。移出影片仍修改全集，再由同一函数重算；清单头部总数读取全集长度，区块结果数读取派生数组长度。未来只有在清单详情真正引入后端分页时，才把同一个 `VideoResourceFilter[]` 合同下沉到 query object；V1 不为尚不存在的分页增加位置参数或浅透传层。

URL 复用 [listQueryParams.ts](../src/renderer/src/listView/listQueryParams.ts) 的 `LIST_PARAM.resources`、`parseVideoResourceFilters()` 和 `videoResourceFiltersParam()`。新增通用 `canonicalizeVideoResourceSearchParams()`，由现有 `canonicalizeLibrarySearchParams()` 和清单详情共同组合，保证深链刷新也会以 replace 清理非法值、重复值和非规范顺序。页面不能自行拼接 `resources` 字符串。

资源摘要和筛选都作用于全局 `video_resources`：不增加 `library_id`、媒体库状态或成员 hidden 条件。这样同一影片分别在两个媒体库拥有 local/web 时两个筛选都能命中；只有确实零资源行时才命中 `none`。该规则与清单跨媒体库读取、清单引用保护和无媒体库成员影片可见性保持一致。

## 12. 并发、幂等和前台 Session 重试

### 12.1 幂等

- start：`idempotency_key` 唯一。
- 页面：`(run_id, page_key)` 在当前 TEMP Session 内唯一，相同 digest 重试返回原 checkpoint，不同 digest 返回 `PAGE_CHANGED`。
- 滚动批次：`(page_id, operation_key)` 在当前 TEMP Session 内唯一；“检查点已写入但响应丢失”返回原批次和下一个 token，不执行第二次滚动。
- 条目：`(run_id, normalized_detail_url)` 唯一。
- 用户决定：`item_id` 唯一并校验 expected revision。
- apply：job 保存 `apply_idempotency_key/outcome_json`；已提交时重复调用返回原 outcome。
- 跨 run 重复导入：复用规则、成员主键、清单成员主键和相关链接唯一键共同防止重复写入。

### 12.2 并发重校验

枚举结束到最终应用之间，影片、清单或媒体库可能变化。apply 必须重新检查：

- 目标媒体库 active 状态。
- 追加目标清单是否存在。
- 全局唯一番号直接复用仍然唯一。
- 多候选快照、强身份解析、候选媒体库成员快照和用户选择仍有效。
- 目标媒体库决胜仍然只命中一条合理候选；用户选择的已有影片仍存在，选择新建时目标媒体库仍可承接成员。
- 详情 URL 是否已经被另一个影片占用并造成身份冲突。

变化导致原决定不再成立时，事务整体回滚，任务回到 `resolving-identities` 或 `waiting_user`，返回 `IMPORT_PREVIEW_STALE`。

### 12.3 Session 生命周期与重试

- 软件只允许一个活动的前台导入 Session；第二次 start 明确返回 `PLAYLIST_IMPORT_ALREADY_RUNNING`。
- 登录或验证码交接只在原 browser session 仍活跃时继续；点击“我已完成，继续”不会创建新 browser session。
- 网络超时、来源变化、总数不一致等可重试错误只允许在同一进程、同一 Session 内处理。当前未封存动态页及其下游 frontier 被清空后，从该页入口 URL 顶部重新读取；已经封存的上游页继续有效。
- browser session 丢失、主进程终止或软件退出时任务终止。TEMP 表随连接关闭而销毁；重新打开软件必须重新发起导入。
- 启动时只关闭通用 Agent 平台中遗留的 `playlist-importer` 运行记录，不恢复其页面、候选、用户决定或 apply 状态。

### 12.4 取消

- apply 前取消：终止 Agent/browser，标记 job cancelled，不改业务表。
- apply 同步事务开始后不强行中断；等待事务提交或回滚，再返回真实终态。
- 新建模式取消不会留下空清单。
- TEMP 页面、条目、决定和 Session 事件随本次连接释放；通用 Agent 活动记录按平台自己的历史策略处理。

## 13. 安全和权限

- 复用元数据 Agent 的公开 HTTP(S)、DNS 和私网地址检查，见 [browserAdapter.ts](../src/main/services/agentMetadata/browserAdapter.ts)。
- URL 不允许用户名、密码或非 HTTP(S) 协议。
- 来源页面和详情页面都视为不可信数据，不视为指令。
- Agent 无权更改冻结的 libraryId、destination 或 apply policy。
- 导航限制在启动时授权的规范 host；www 变体可归一化。跨子域或跨域详情链接要求显式的 host policy，不能由页面自动扩大。
- `advance_page/open_item_detail` 在动作前校验宿主签发的 navigation ref；click 还要在主 frame request 层阻断未授权目标，不能等请求发出后只检查最终 URL。
- 相关链接不保存 URL 凭据。包含 access token、signature、credential 等敏感查询键的详情 URL拒绝落库并进入用户处理。
- 工具 ledger 只保存脱敏 URL、计数、digest 和摘要，不保存页面中的凭据或 cookie。
- 登录和验证码只允许 browser handoff；用户不得把密码、验证码或 token 发给 Agent。
- 页面证据保存在 run 自己的 workspace 下，evidence ref 不能越出该目录。
- 宿主状态机固定限制每 run 最多 5,000 个逻辑页、每页最多 5,000 个动态批次、每个动态批次最多 500 个渲染候选、每 run 最多 20,000 个 occurrence，且从任务创建起最多持续 24 小时；共享 browser 继续负责 URL、页面证据大小、单动作等待与滚动 settle 上限。达到任一预算时任务以 `LIMIT_REACHED` 失败，禁止缩小、截断或重复提交来伪装完成。

## 14. IPC、Preload 和 renderer 状态

### 14.1 共享类型和通道

新增 `src/shared/playlistImportTypes.ts`，保存 start/control/snapshot/outcome/error 的唯一共享定义。

新增通道：

```text
PLAYLIST_IMPORT_START
PLAYLIST_IMPORT_SNAPSHOT
PLAYLIST_IMPORT_CONTROL
PLAYLIST_IMPORT_SNAPSHOT_CHANGED
```

同步修改：

- [ipc-channels.ts](../src/shared/ipc-channels.ts)
- [appIpcContract.ts](../src/shared/appIpcContract.ts)
- [ipcCommandSchemas.ts](../src/main/ipc/ipcCommandSchemas.ts)
- [preload/index.ts](../src/preload/index.ts)

Preload 暴露：

```ts
api.playlistImport.start(input)
api.playlistImport.snapshot(runId?)
api.playlistImport.control(runId, command)
api.playlistImport.onSnapshotChanged(listener)
```

所有 ID、URL、枚举、字符串长度、数组数量和 expected revision 都由 Zod schema 验证。

### 14.2 主进程 handler

新增 `playlistImportHandlers.ts`：

- 注册三个命令和一个主进程事件桥。
- 导入弹窗在运行中不可被遮罩或 Escape 关闭；显式终止会取消任务。
- 订阅 `PlaylistImportModule`，使用现有 `IpcContext.sendToAll()` 模式发布 revision 事件。
- 应用启动时不恢复导入任务；模块初始化只关闭遗留的通用 `playlist-importer` Agent 记录。

### 14.3 renderer Module

新增：

- `PlaylistImportModal.tsx`：统一开始、进度和身份选择。
- `PlaylistImportProvider.tsx`：全局活动 run、changed event、轮询兜底和完成通知。
- `PlaylistImportProgress.tsx`：页面内紧凑进度视图。
- 对应 CSS Module，全部使用语义 token。

`PlaylistImportProvider` 挂在 [App.tsx](../src/renderer/src/App.tsx) 的全局 provider 层，只服务当前打开的导入弹窗，不通过无参数 snapshot 自动接回旧任务。

任务完成后刷新：

- 清单列表和目标清单详情。
- 只有实际新建影片时才刷新目标媒体库影片列表、统计和首页发现；复用影片不改变其媒体库成员。
- 所有被复用影片的全局详情和相关链接投影。
- 全局搜索中受影响的影片投影。

使用现有 React Query invalidation helpers；仍以手动 local state 加载的清单页面应显式重新调用 load。

## 15. 错误合同

| 错误码 | 阶段 | 是否可恢复 | 行为 |
|---|---|---:|---|
| `INVALID_SOURCE_URL` | start | 否 | 保持表单，不创建 run |
| `TARGET_LIBRARY_NOT_FOUND` | start/apply | 否 | 要求重新开始 |
| `TARGET_LIBRARY_ARCHIVED` | start/apply | 是 | 恢复媒体库后继续或重开 |
| `TARGET_PLAYLIST_NOT_FOUND` | start/apply | 否 | 追加模式失败；新建模式不适用 |
| `NETWORK_TIMEOUT` | discovery/detail | 是 | 同页面幂等重试 |
| `BROWSER_SESSION_LOST` | discovery/detail | 否 | 终止本次 Session，要求重新导入 |
| `CHALLENGE_REQUIRED` | browser | 是 | 进入 browser handoff |
| `PAGE_CHECKPOINT_REQUIRED` | discovery | 是 | 留在当前页，先固化 |
| `PAGE_CHANGED` | discovery | 是 | 重读并重新 checkpoint 当前页 |
| `PAGINATION_LOOP` | discovery | 否 | 不允许 finish |
| `PAGINATION_INCOMPLETE` | discovery | 是 | 继续 frontier |
| `SCROLL_TARGET_INVALID` | browser/discovery | 是 | 留在当前页，修正或重新发现唯一滚动容器 |
| `SCROLL_STALLED` | discovery | 是 | 同一 Session 从当前页起点重试；仍非底部则明确失败 |
| `SCROLL_LOOP` | discovery | 否 | 不允许 seal 或 finish |
| `VIRTUAL_LIST_CONTINUITY_UNPROVEN` | discovery | 视情况 | 缩小步长或改用稳定位置；仍无法证明则失败 |
| `TOTAL_MISMATCH` | discovery | 是 | 保持未完成并重新核对来源 |
| `SOURCE_CHANGED` | discovery/detail | 视情况 | 同一 Session 重读当前未封存页，或要求重新开始 |
| `UNSUPPORTED_LIST_STRUCTURE` | discovery | 否 | 明确失败，不标记完成 |
| `UNSUPPORTED_PAGINATION` | discovery | 否 | 无法证明连续性或终点时明确失败 |
| `ITEM_CODE_MISSING` | identity | 是 | 打开详情或交用户创建 |
| `ITEM_IDENTITY_AMBIGUOUS` | identity | 是 | 进入用户选择 |
| `IDENTITY_REVIEW_STALE` | identity | 是 | 刷新候选和选择 |
| `IMPORT_PREVIEW_STALE` | apply | 是 | 回滚并重算决定 |
| `APPLY_FAILED` | apply | 是 | 事务回滚，可重试 |
| `NO_ITEMS_FOUND` | discovery | 否 | 不创建清单或业务记录 |
| `LIMIT_REACHED` | 任意 | 视情况 | 不以截断结果完成 |

## 16. Browser 能力边界

V1 在共享 Agent browser Interface 增加受控纵向滚动，但不扩展生产插件沙箱的 `ctx.browser.*`。最小命令合同为：

```ts
type BrowserScrollCommand =
  | {
      action: 'scroll'
      target?: string // 唯一主 frame selector/当前 ref；省略为 document.scrollingElement
      direction: 'up' | 'down'
      amount?: 'eighth-viewport' | 'quarter-viewport' | 'half-viewport' | 'viewport' // 默认 half-viewport
    }
  | {
      action: 'scroll'
      target?: string
      direction: 'start'
    }
```

V1 只支持即时纵向滚动，不开放任意像素、横向、smooth、wheel、坐标或 `to-end`。目标必须位于主 frame、可见且唯一；Importer 初次枚举先执行 `start` 并确认 `atStart`，后续固定用 `half-viewport` 保留相邻窗口重叠。动作通过现有 post-action observation 返回：

```ts
interface BrowserScrollState {
  containerFingerprint: string
  before: { scrollTop: number; scrollHeight: number; clientHeight: number }
  after: { scrollTop: number; scrollHeight: number; clientHeight: number }
  deltaY: number
  moved: boolean
  atStart: boolean
  atEnd: boolean
  settled: boolean
}
```

滚动前开启现有脱敏 network capture，设置位置后等待两个 animation frame 和有界的 scroll-metrics settle，再生成完整 artifact；Importer Adapter 再按冻结候选 digest 做业务级 settle，不要求广告等无关网络完全 idle。不得自动重放 observation pending、abort 或可能诱发导航的滚动；调用者用 status/snapshot 和当前 Session frontier 判定下一步。

浏览器必须把导航身份与渲染窗口身份分开：`documentRevision` 仍只随主 frame 导航变化；新增宿主单调 `viewRevision`，每次受控 scroll 后生成新值。ARIA ref 绑定 `viewRevision`，滚动一开始就让上一窗口 ref fail closed，post-action snapshot 返回的新 ref 才可使用。Evidence baseline 也按 `viewRevision` 生成 full/delta/unchanged，不能在同一 document revision 下硬编码 `staleRefs: false`。滚动是否取得业务进展由 metrics 和候选 digest 判断，不能用 revision 代替。

通用 observation 仍会截断链接集合和 HTML，因此不能把 observation 返回的链接数当作大清单完整性证明；V1 依靠 `PlaylistImportAgentRunDriver` 的冻结 selector，在每次受控滚动的同一宿主操作中从活页面同步提取 metrics 与当前窗口全部候选并立即暂存。ToolPack 虽允许 Agent 使用通用 `scroll` 处理页面交互和恢复，但该动作不会认领或推进导入 frontier，也不会固化候选；清单分页、加载更多和虚拟枚举必须使用 `advance_playlist_page`，后续 checkpoint 会按当前 `in-flight` 冻结工作项与 revision fail closed。

V1 支持：

- 单页清单。
- 明确下一页链接。
- 编号分页链接。
- 可点击“加载更多”，且每次点击后候选/分页 digest 可观察。
- `document.scrollingElement` 或唯一 overflow 容器中的有限虚拟列表，包括回收 DOM 节点的列表；条目必须提供 `aria-posinset` 或稳定绝对位置属性。
- 滚动触发懒加载，但每个条目最终进入可观察 DOM，且能证明从顶部连续遍历和稳定终点。
- 同一逻辑页先完成虚拟枚举，再继续 next-link、编号分页或 load-more 的组合。
- 登录/人机验证后由用户 handoff 继续。

V1 明确不支持：

- 真正无终点的 feed，或在安全预算内无法证明终点的滚动列表。
- 没有稳定绝对位置的虚拟列表。
- canvas/自定义 wheel 驱动但没有可测 `scrollTop/scrollHeight/clientHeight` 的列表。
- 只在网络 API 中暴露、不进入可观察 DOM 的游标分页。
- 跨域 iframe 内的清单。
- 页面没有可观察总数或分页入口却把内容隐藏在客户端状态中的情况。
- 导入遍历期间外部清单本身持续增删时的一致快照。
- 无法从顶部重放并验证累计 occurrence prefix 的 JS 内存状态。

遇到这些情形必须返回 `UNSUPPORTED_PAGINATION/UNSUPPORTED_LIST_STRUCTURE/LIMIT_REACHED`，不得让 Agent 猜测“已经读完”。完成 V1 scroll 后，后续 browser 改进优先级为：

1. 增加脱敏、只读的网络响应/API 游标观察。
2. 增加声明总数、页面数与捕获条目的通用 reconciliation 帮助器。
3. 增加 click 前的通用主 frame navigation policy，而不只由本功能 Adapter 防守。
4. 如高频站点确有需要，再增加第一个确定性站点 Adapter；届时才引入生产 Adapter 选择 seam。

## 17. 主要实现落点

- 决策记录：`docs/adr/0025-import-external-playlists-with-global-catalog-reuse.md`。
- 共享合同：`src/shared/playlistImportTypes.ts`、IPC schema 与 preload 合同。
- 领域与 Session：`src/main/services/playlistImport/playlistImportModule.ts`、`playlistImportRepository.ts`、`playlistImportRunDriver.ts`。
- Agent 合同：`src/main/services/playlistImport/playlistImportInstructions.ts`、`toolPack.ts`、`playlistImportBrowserNavigation.ts`。
- 共享 browser：`src/main/services/agentMetadata/browserAdapter.ts` 负责 session、URL policy、证据和通用页面动作；`src/main/scrapers/scrapeBrowser.ts` 在主 frame request 发出前执行导航 policy。
- renderer：`src/renderer/src/components/playlistImport/PlaylistImportContext.tsx`、`PlaylistImportIdentityReview.tsx` 与 `events.ts`；入口位于清单页和清单详情页。

共享 `scroll` 进入 Agent browser 命令和宿主 observation/evidence；`playlist-importer` 复用 `AgentMetadataBrowserAdapter` 获得独立 session 与同站点 URL policy，PluginDev 仍使用自己的 browser capability。不要把该命令加入 `PluginBrowserAction` 或生产插件 `ctx.browser`，后者不属于本需求。清单领域工具在共享滚动原语之上封装回顶、半 viewport 步长、连续性和批次事务，Agent 看不到像素与循环细节。

资源筛选沿用已有 `VideoResourceFilter`、URL parser/serializer 和 `Video.resource_kinds` 投影，不修改 playlist IPC/preload Interface。把 `LibraryFilterPopover` 内现有资源 checkbox 抽成 `VideoResourceFilterFieldset`，由媒体库筛选和新的 `PlaylistResourceFilterPopover` 共同使用；新样式进入同名 CSS Module，并删除迁出的 legacy 全局规则，避免两处资源顺序、文案和 OR 提示漂移。playlist popover 使用 `FloatingLayer`，防止被详情滚动容器裁剪。

若通用化 Metadata Agent browser 的 URL/evidence/session 能明显减少重复，可把公共实现提取到 `src/main/services/agentBrowser/`。提取必须保持 Metadata Agent 行为和测试不变，不为了本功能制造一层只转发的浅 Module。

## 18. 实施阶段

### Phase 0：领域和决策

- 新增 ADR，记录方案 3、全局唯一番号快速复用、跨库候选以及目标媒体库决胜规则。
- 更新 `CONTEXT.md`，明确清单、清单引用保护和外部清单导入目标媒体库的全局边界。
- 固定 `policyVersion: 1`、错误码和完成定义。

### Phase 1：Session 仓储和纯领域 Module

- 由 Repository 在当前 SQLite 连接中创建 TEMP Session 表，包括独立的 `playlist_import_scroll_batches` 和 `playlist_import_session_events`；V14 发布 schema/migration 不增加导入暂存表。
- 实现 URL/click/scroll frontier、逻辑页/渲染批次、URL/番号规范化、occurrence 对齐去重和身份 resolver。
- 实现 `PlaylistImportMutationRepository` 单事务应用。
- 让媒体库成员清理和全局无资源影片清理都跳过 `playlist_video` 中仍被引用的影片。
- 移除清单计数、预览和详情 read model 中隐含的 active/visible 媒体库过滤。
- 用 SQLite `:memory:` 测试 Module Interface 和数据库约束。

### Phase 2：Agent 和 Browser Adapter

- 在共享 Agent browser 增加受控 `scroll`、`scrollState`、独立 `viewRevision`、旧 ref 失效和滚动期间脱敏 network capture；不扩生产插件沙箱。
- 注册 `playlist-importer` Definition/Profile/ToolPack。
- 实现页面 checkpoint token、虚拟页 scroll frontier、批次原子落盘和受控 advance/open-detail。
- 实现详情证据、同一 browser session 的 handoff、当前未封存页重试和每次状态变更后的自动完成 gate。
- 使用 scripted page graph 测试单页、下一页、编号分页、加载更多、有限虚拟列表、滚动懒加载、循环、当前页重试和页面变化。

### Phase 3：IPC 和统一 UI

- 增加共享类型、IPC contract/schema、preload namespace 和事件。
- 实现前台 provider、统一 modal 和身份选择；运行中只能通过明确按钮结束，不提供后台入口。
- 接入清单列表页和清单详情页。
- 在清单详情影片区块接入 URL 化的资源类型多选、筛选按钮计数、匹配/总数和筛选空状态；复用全局资源摘要，不扩大 playlist IPC。
- 关闭嵌套影片详情时静默刷新清单详情，保留 `resources`；返回清单根时剥离该详情专属参数并保留 `q`。
- 完成后刷新清单和受影响的全局影片投影；仅有新建影片时刷新目标媒体库、首页和统计。

### Phase 4：完整性和发布门禁

- 单前台 Session、退出不恢复、取消、同一 Session 幂等和并发 stale 测试。
- 安全测试：SSRF、跨 host、敏感 URL、prompt injection、证据路径逃逸和上限。
- Electron fixture QA：新建、追加、用户消歧、登录交接、显式终止和完成跳转。
- 运行全部静态、测试、构建和打包 runtime 门禁。

## 19. 测试矩阵

### 19.1 Module Interface 测试

1. 新建模式在 discovery 期间不创建空清单。
2. 追加模式冻结清单和媒体库，Agent 无法改写目标。
3. 一页、三页、编号分页和加载更多全部形成连续 checkpoint。
4. 当前页未 checkpoint 时拒绝 advance。
5. frontier 非空、总数不符或页面证据缺失时拒绝 finish。
6. 清单枚举完成前拒绝打开详情页。
7. 进入身份阶段后拒绝返回清单页。
8. 同详情 URL 跨页重复只保留第一次来源顺序。
9. 同番号不同详情 URL不在发现阶段错误去重。
10. 全局目录唯一完全匹配番号直接复用且不打开详情页，即使影片只属于其它媒体库。
11. 同一影片 ID 同时属于多个媒体库时仍只算一个候选。
12. 多个全局完全匹配影片 ID 必须先打开详情页，即使目标媒体库中恰好有一个候选。
13. 详情 URL、source ID、完整业务身份分别能唯一消歧；唯一命中其它媒体库候选时不被目标媒体库覆盖。
14. 强信号无冲突但仍有多个合理候选，且恰好一条属于目标媒体库时自动使用目标媒体库决胜。
15. 目标媒体库有多个合理候选或没有合理候选时进入用户选择。
16. 冲突强信号、番号冲突和无法定义合理候选集合时不得使用目标媒体库决胜。
17. 标题相同不能单独自动消歧。
18. 用户可选择任一全局已有候选，或明确在目标媒体库创建新影片。
19. 全局目录 0 条且自动创建开启时，在目标媒体库创建 `scraped_status=0` 的无资源影片；关闭时跳过。
20. 复用已有影片不新增目标媒体库成员，不修改来源成员、资源、hidden 或 pin。
21. 保存详情链接开启时，新建和追加都把每个详情 URL 追加为最终影片相关链接；关闭时不写入。
22. 保存来源清单链接开启时，新建和追加都把外部清单 URL 去重追加到目标清单相关链接；默认关闭时不写入。
23. 导入不覆盖已有影片字段、用户链接标签或清单已有顺序。
24. 清单计数和详情同时显示来自多个媒体库以及没有媒体库成员的被引用影片。
25. 被任一清单引用时，媒体库全量扫描不会移除其无资源成员。
26. 被任一清单引用时，全局无资源清理不会删除影片；移除最后一个清单引用后恢复可清理。
27. 显式移除媒体库成员或影片不被清单引用保护静默阻止。
28. 全部写入在一个事务；任一失败时无业务半成品。
29. 重复 start/checkpoint/control/apply 返回相同结果且不重复创建。
30. apply 前目录或候选成员关系变化触发 stale，回滚并重新解析。
31. completed 时每个唯一 item 都有最终 videoId 和清单关系，只有新建影片必须有目标媒体库成员。
32. 虚拟逻辑页在连续性、终点、声明总数或 scroll frontier 未完成时不能 seal/finish。
33. 渲染窗口重叠不会增加逻辑 occurrence；同 URL 位于两个显式位置时保留两个 occurrence、一个 work item。
34. 虚拟列表与 next-link/load-more 可组合，只有本逻辑页 sealed 后才签发页面 advance token。
35. scroll 批次 operation key 幂等；“已提交但响应丢失”不会再次滚动或重复写 occurrence。
36. `pagesRead` 统计 sealed 逻辑页，`scrollWindowsRead` 统计当前 Session 批次，两者不混算。
37. 清单详情为每个跨库影片投影去重后的全部 `resource_kinds`；资源只位于 hidden 成员或 archived 媒体库时仍保留该事实。
38. 没有任何媒体库成员但被清单引用的影片仍返回；零资源时 `resource_kinds=[]`，可被 `none` 精确识别。

### 19.2 Agent/Browser 测试

1. 页面内容中的指令不能改变目标或调用未授权工具。
2. 默认和 `allowInputActions` 两种共享 browser schema 都包含严格 `scroll` 分支；缺 direction、非法 amount、像素/横向/smooth/to-end 参数和额外字段均被拒绝。
3. document 与唯一 element 容器都能执行 start/up/down、half/full viewport、边界 clamp，并返回准确 before/after/moved/atStart/atEnd/settled。
4. 空 target、0 个或多个匹配、跨域 iframe 与不可测滚动容器先失败，不发生页面动作。
5. `documentRevision` 在滚动时保持导航身份，`viewRevision` 变化；滚动前的 ARIA ref 立即 stale，新 observation 的 ref 才有效。
6. scroll observation 仍生成完整 artifact，超限走既有 64 KiB fallback；同 document 的新 view 不得被错误压成 `unchanged + staleRefs:false`。
7. 滚动期间 XHR/fetch 进入脱敏 recentRequests；abort、observation pending 或意外导航不自动重放 scroll。
8. Metadata 和 PluginDev Adapter 都映射共享 scroll 并保持 URL policy；生产 `PluginBrowserAction/ctx.browser` 不出现 scroll。
9. 通用 browser scroll 可用于页面交互和恢复，但不能认领或推进 frontier，也不能创建页面检查点；pending 页面必须先由 `advance_playlist_page` 原子认领为 `in-flight`，否则 checkpoint 被拒绝。
10. 虚拟页首次枚举强制回顶并确认 `atStart`，不能继承浏览器历史位置。
11. 每个 scroll advance 都在一次宿主操作内完成“上一批已提交校验 → 半 viewport 滚动 → settle → 同步读取 metrics/候选 → 连续性校验 → 事务落盘”；返回前不能发生下一次滚动。
12. 只保留 8 个 DOM 节点的 100 条虚拟列表仍得到全部 occurrence，证明不依赖最终 DOM。
13. `aria-posinset` 和稳定 index attribute 两种虚拟位置策略都保持无缺口顺序；缺少绝对位置时失败。
14. overscan/窗口重叠不重复计数；同详情 URL 位于两个显式位置时保存两个 occurrence、一个唯一影片 item。
15. 加载更多的完整 DOM 前缀发生重排、替换或点击后无新增时返回 `SOURCE_CHANGED/LOAD_MORE_NO_PROGRESS`，不得静默去重。
16. 虚拟列表与加载更多组合时，稳定到底但按钮仍可用不能 seal；点击动作必须先写入当前 Session 检查点，按钮耗尽并再次稳定到底后才能进入身份阶段。
17. 可变高度卡片无重叠时回到最后 anchor 并有限减半步长；达到最小步长仍无法衔接则失败。
18. 懒加载令 scrollHeight 增长或出现新条目时清零终止探测；单次 atEnd/no-new-item 不能 seal。
19. 未知总数只有连续两次 moved=false、atEnd、metrics/末批 digest 稳定且无新增时才能 seal；已声明总数还必须核对连续 occurrence。
20. 虚拟列表滚完后仍有 next-link，及每个编号分页页内部各有虚拟列表，两种组合都完整清空 frontier。
21. 单页超过通用 observation 链接/HTML 上限时，冻结 selector 仍由宿主在活 DOM 中全量提取当前窗口。
22. 每页逻辑 occurrence 数与 sealed `observed_item_count` 一致，跨页重复仍保留审计证据。
23. AJAX/load-more 在 document revision 不变时仍用入口 frontier key 建逻辑页，并用候选/分页 digest 检测进展。
24. 分页循环、滚动循环、非底部 stalled、未变化 load-more 和所有安全上限都被检测，不能伪装完成。
25. challenge/login 进入 handoff；原 browser session 仍存在时，用户完成操作后从当前 Session checkpoint 继续。
26. browser session 丢失后任务明确失败，不新建会话、不重放旧滚动窗口，重新打开软件也不会接回任务。
27. 同一 Session 覆盖“批次已提交但响应未返回”的幂等窗口；可重试错误从当前未封存页顶部重读。
28. 详情阶段只允许打开已冻结的待处理 item URL。
29. 点击分页前校验目标，未经授权的导航请求不能先发出再事后拒绝。
30. 真正无终点、无法连续对齐或无法证明终点的列表命中 `LIMIT_REACHED/UNSUPPORTED_PAGINATION`，不得完成。
31. 启动首轮对话分发前宿主不打开来源页；Agent 通过通用 `browser open` 加载冻结工作项，challenge 仍经同一 browser handoff 进入等待用户状态。

### 19.3 IPC/UI 测试

1. 清单列表入口默认新建，清单详情入口默认追加当前清单。
2. 开始前必须选择 active 媒体库，并明确说明它只承接新建影片和跨库重复决胜。
3. 新建/追加使用同一 modal 和 start input。
4. start 立即返回；运行中的 modal 不能点击遮罩、按 Escape 或通过后台按钮关闭。
5. changed event 更新当前 Session 快照，不用无参数 snapshot 接回旧任务。
6. 未知总页数不显示虚假百分比。
7. 身份选择校验 expected revision，陈旧选择提示刷新。
8. 身份选择展示全部全局候选及其媒体库，目标媒体库候选有清晰但非强制覆盖证据的优先标记。
9. 取消任务不留下空清单或部分影片。
10. 完成 toast 可跳转最终清单，并刷新相关列表。
11. 页面 reload、主进程终止或应用重启后不恢复导入进度；重新导入时创建新 Session。
12. 清单详情无资源筛选时显示全部影片；local、direct、web、magnet、ed2k 单项分别正确。
13. 多选按 OR；多资源影片只出现一次；`none + magnet` 返回两个集合的并集。
14. `none` 只匹配全局零资源影片；跨库资源、hidden 成员、archived 媒体库和 STRM 目标类型语义正确。
15. `resources` 的非法、重复、乱序值被 canonicalize；空选择删除参数，筛选交互使用 replace。
16. 资源筛选按钮显示已选数量；popover 可调整或清空全部条件，count 显示匹配数和总数，网格上方不再重复显示 chip 条。
17. 清单真实为空与筛选后零命中显示不同空状态，清除筛选动作可恢复结果。
18. 清单详情 → 影片详情 → 演员详情及逐层返回始终保留 `q + resources`；系统后退不经过每次筛选勾选历史。
19. 从清单详情显式返回、删除清单后返回或侧栏返回 `/playlists` 时剥离 `resources` 并保留 `q`。
20. 在影片详情新增、删除或改变资源后返回，清单静默刷新并按原 `resources` 重新过滤。
21. 排序切换、从筛选结果移出影片和刷新深链时，筛选、总数与显示顺序保持一致。

### 19.4 迁移和门禁

- V13 → V14 数据库迁移测试和 fresh schema 等价测试。
- 外键检查、唯一约束、rollback 和大清单 prepared-statement 性能 fixture。
- `npm run typecheck`
- `npm run lint`
- `npm run check:css-architecture`
- 相关定向测试和完整 `npm test`
- `npm run build`
- `npm run test:packaging`
- `npm run packaging:verify-agent-runtime`
- `git diff --check`

## 20. 验收清单

- [ ] 清单列表页可以从外部 URL 新建清单。
- [ ] 清单详情页可以向当前清单追加，也能切换到新建。
- [ ] 两个入口共用同一 Module、IPC、modal 和任务状态。
- [ ] 开始导入只等待浏览器 Session、Agent run 和首轮对话被接受，不等待来源页导航；来源页由 Agent 使用通用 browser 打开。
- [ ] 任务开始前显式选择目标媒体库，开始后不可改变。
- [ ] 每个清单页先固化完整候选和分页证据，再允许离开。
- [ ] 共享 Agent browser 提供受控纵向 scroll、滚动 metrics 和独立 view revision，滚动后旧 ARIA ref fail closed。
- [ ] 有限虚拟列表和滚动懒加载从顶部开始，每个渲染窗口在下一次滚动前已写入当前 Session checkpoint，DOM 回收不会漏项。
- [ ] 虚拟窗口用稳定绝对位置证明连续性，重叠窗口不重复增加来源条目数；没有绝对位置时明确失败。
- [ ] 单次到达底部不算完成；稳定终点、声明总数和所有 scroll/page frontier 全部核对后才 seal。
- [ ] 全部分页完成前不打开影片详情页。
- [ ] 全部分页完成后不再返回清单页。
- [ ] 全局目录内唯一规范化番号完全匹配时跨媒体库直接复用，不新增目标媒体库成员。
- [ ] 全局目录内多个完全匹配影片 ID 时先读取详情页消歧。
- [ ] 唯一强身份信号可以选择其它媒体库影片，目标媒体库不能覆盖该证据。
- [ ] 详情后仍有多个合理候选时，仅在目标媒体库恰好一条时自动决胜，否则由用户选择。
- [ ] 全局目录内无匹配或用户明确选择新建时，才在目标媒体库创建无资源影片。
- [ ] 清单详情和计数不按媒体库过滤，可同时展示跨库和无成员影片。
- [ ] 清单详情可按 local/direct/web/magnet/ed2k/none 多选筛选，多选为 OR，资源事实跨媒体库聚合。
- [ ] 资源筛选写入规范化 `resources` query，以按钮计数反馈；影片/演员详情往返保留，返回清单列表时剥离。
- [ ] 清单总数、筛选匹配数、真实空清单和筛选零结果分别正确展示。
- [ ] 影片详情修改资源后返回清单会静默刷新，并按原筛选条件重新计算结果。
- [ ] 被任一清单引用的影片不会被媒体库扫描或全局无资源清理自动移除。
- [ ] 导入不修改用户 pin；最后一个清单引用移除后，未固定且无资源的影片恢复可清理。
- [ ] 每个外部详情 URL 都出现在对应影片相关链接中。
- [ ] “保存来源清单链接”默认关闭；开启后外部清单 URL 出现在目标清单相关链接中，重复导入不重复添加。
- [ ] 不创建影片资源，不覆盖已有影片元数据和用户链接。
- [ ] 新建清单只在最终事务中创建，取消不留空清单。
- [ ] 追加保留既有清单信息、影片和顺序。
- [ ] 同一 Session 的重复 checkpoint、control 和 apply 不会产生重复记录；应用重启不会接回旧导入。
- [ ] completed 只在全部唯一影片完成原子写入后出现。
- [ ] 真正无终点、无法证明连续性/终点或无法从顶部验证重放的列表明确失败，不伪装成完整导入。

## 21. 完成定义

功能只有在以下条件全部满足时才算完成：

1. 领域术语和 ADR 已记录全局候选、跨媒体库复用、目标媒体库决胜和清单全局读取的范围及风险。
2. `PlaylistImportModule` 的 Interface 测试覆盖完整状态机和全部匹配分支。
3. 页面检查点和 URL/click/scroll frontier 能阻止提前进入详情阶段或提前完成；有限虚拟列表 fixture 在 DOM 回收和懒加载后仍证明无缺口。
4. 最终事务证明没有半成品，并能在同一 Session 重试后返回相同 outcome。
5. 自动成员清理和全局无资源影片清理都有“仍被清单引用则跳过”的回归测试。
6. 新建和追加两个入口通过同一套 UI、IPC 和 Module。
7. 清单详情的全局资源投影、`none`/多选 OR、URL 生命周期、筛选空状态和资源变更后刷新具有自动化测试。
8. 共享 browser 的 scroll schema、唯一目标、滚动 metrics、view revision、旧 ref 失效、network capture 和 observation artifact 具有自动化测试。
9. 所有验收清单具有直接自动化测试或隔离 Electron QA 证据。
10. typecheck、lint、CSS architecture、完整测试、构建和打包 Agent runtime 检查全部通过。
