# 大型媒体库 UI / IPC 性能审计与实施计划（Issue #100）

2026-09-11 连续浏览更新：桌面浏览列表及候选选择器已接入三页窗口与共享虚拟组件，适用范围与验证见[连续浏览记录](desktop-continuous-browsing.md)。

2026-09-11 更新：主列表缓存窗口、大选集预览及清单/分类详情分页已按DG落实，最新结果与保留边界见[DG报告](large-library-window-selection-results.md)。以下原始风险描述保留为历史基线。

本文保留原始基线审计；后续代码与验收见[实施记录](large-library-implementation-status.md)。例如AC已将LibraryPage已选标签名称改为按ID窄查询并消除缺失标签重试循环，下面的原始旁路描述不代表最新工作区；AD已完成手工标签候选的按需分页、按ID添加和两种桌面尺寸的组件浏览器验收；AG已将TagFilter改为名称分页和本页计数，并验证真实父弹层；AL已将PendingCenter刮削队列改为概要分页和选中后取详情；AM已将MediaLibrarySettings的刮削待办状态改为100项审计页的ID存在性查询，并限制审计DOM；AN进一步移除设置页扫描/身份全量详情，改为三类ID合计100的单页查询；AO将PendingCenter扫描/身份组合队列改为概要分页、仅选中项读取详情；AS已接入演员概要分页与单组详情，AT修复合并预检的重复名称归一化；AU准备了演员身份候选窄分页接口，AV已接入“选择其他演员”弹窗，并用窄身份读取完成选择确认。原始审计文件及其余实体分页仍待处理。共享缓存与其余验收仍待完成。

## 结论与审计边界

基线：`dev`，提交 `4c953a9`；审计日期：2026-09-10。问题背景由任务提供：Windows、机械硬盘、300,382 部影片、约 1 GB 数据库。这里的 1 GB 是数据库规模，**不是 renderer 堆大小、IPC 包大小或图片总量**。未读取 Issue 远端正文，未访问用户数据库，未启动应用或执行性能基准；以下是当前代码的静态证据与待验证推断，不是该用户机器的实测根因。

主列表已有有效保护：媒体库每页 200 部、首页/全局搜索每页 120 部、演员主列表每页 240 位，并使用虚拟网格。真正需要优先治理的是旁路：清单与演员详情整包加载关联影片，侧栏定时获取完整待确认快照，分类列表/选图全量读取，以及无限查询长期累计后被广泛刷新。图片读取还会与同步 IPC 查询争用主进程；即使 renderer DOM 已有界，也不能保证 HDD 上的交互延迟有界。

范围包括桌面 renderer、preload、IPC 及证明其返回边界必需的查询服务/仓储终点；包括 Web UI 的状态、DOM、图片和键盘导航。**不审计 Web 后端、SQLite 索引/迁移方案、扫描器或刮削插件内部算法**。插件目标选择器仅检查 UI 消费的查询契约。所有实施建议均为计划，本次只写本文件，不修改生产代码、用户数据或 GitHub。

已阅读根目录 `AGENTS.md`、[UI 设计规范](../UI_DESIGN_GUIDELINES.md)、[组件契约](../UI_COMPONENT_CONTRACTS.md)、[路由设计](../ROUTING_DESIGN.md)、[移动 Web 规范](../MOBILE_WEB_GUIDELINES.md)及[演员分页基准](actress-list-pagination.md)。源码定位均采用仓库相对路径和 **4c953a9 的一基行号**，范围用 `:起始–结束` 表示。

## 判断口径

- **单次返回有界**：请求或服务端明确限量；这不等于查询执行成本有界，也不等于每行字节数有界。
- **累计无界**：没有固定保留预算，可随已浏览页数增长，最坏达到整个匹配集合；并非打开页面就读全库。
- **DOM 有界**：只挂载视口与缓冲单元，或只展示当前页；滚动容器、懒加载图片、CSS 隐藏均不自动实现虚拟化。
- 记 `N` 为匹配影片数，`A` 为演员候选数，`F` 为分类实体数，`P` 为清单数，`K` 为单演员/清单/分类的关联影片数，`T` 为标签数，`Q` 为待确认影片数，`L` 为已加载条目数，`S` 为选中数。它们不能全部代入 300,382；实际分布尚未知。
- 优先级：P1 是大集合下可直接放大且应先治理的路径；P2 是受使用深度或特定功能触发的风险；P3 是后续微调/观测。没有证据支持认定普遍不可用的 P0。

## 入口、调用链与边界总表

统一桥接是 `apps/desktop/src/renderer/src/api.ts:1–9` 的 `window.api` → `apps/desktop/src/preload/index.ts:128–167` 的 `ipcRenderer.invoke` → `apps/desktop/src/main/ipc/typedIpcAdapter.ts:36–46` → `apps/desktop/src/main/ipc/shared.ts:18–40`。返回是完整 `IpcResponse.data`，没有流式分片；包装成 Promise 不会把 handler 内同步仓储工作移到 worker。

| UI 入口与准确定位 | 真实 IPC / 查询终点 | 返回、保留与 DOM 边界 | 判定 |
| --- | --- | --- | --- |
| `LibraryPage.tsx:383–398,1039`（路径均在 `apps/desktop/src/renderer/src/pages/`） | `useInfiniteVideoList.ts:29–46` → preload `:365` → `videoHandlers.ts:12–15` → `videoQueryService.ts:38–39` → `scopedVideoCatalogRepo.ts:365–381` | 每页 200；每次有 COUNT + LIMIT/OFFSET；已读页累计；`VirtualPosterGrid` 限定 DOM | 首屏有保护，深浏览/刷新仍有风险 |
| `HomePage.tsx:80,111–139,219,268–316` | preload `:253–254` → `mediaLibraryHandlers.ts:82–83` → `homeDiscoveryRepo.ts:274–304` | 普通首页请求近期/发现各 12；媒体库摘要随库数增长；搜索每页 120、累计、虚拟 DOM | 不存在首页直接渲染 30 万影片的证据 |
| `GlobalSearchPage.tsx:26,57–86,199` | `api.home.search` → 上述 HOME_SEARCH → `catalog.list` | 空搜索禁用；每页 120，已读页与库 ID Map 累计；虚拟 DOM | 分页有界，缓存无固定页预算 |
| `ActressesPage.tsx:100,174–188,609` | preload `:472` → `actressHandlers.ts:11–13` → `actressQueryService.ts:90–142` → `actressRepo.ts:471–500` | UI 每页 240，仓储显式 limit 最大 1000；虚拟 DOM；头像筛选另见 F06 | 普通列表已优化，不能重复报成全量 |
| `DetailPage.tsx:248–281,1105` | preload `:366` → `VIDEO_GET` → `videoQueryService.ts:41–64` → `scopedVideoCatalogRepo.ts:440–457` → `videoRepo.ts:1091` | 单影片；附带演员、资源、标签、样张等集合，按该影片关联规模增长 | 非全库读取，但详情集合无独立分页 |
| `ActressDetailPage.tsx:104–137,452` | preload `:474` → `actressHandlers.ts:17–19` → `actressQueryService.ts:84–85` → `actressRepo.ts:541–583` | 一次取得该演员全部可见关联影片及写真；全部影片 map | F02，返回/DOM 都随 K 增长 |
| `FacetListPage.tsx:9–15` → Organization/Director/Series 列表 | preload `:500,516,527` → `facetHandlers.ts:37–39,70,88` → `classificationQueryService.ts:93–145,349–387,501–547` | 全部匹配分类实体；每项已有摘要投影；普通 map | F03，随 F 增长，并非全部影片 DTO |
| Organization/Director/Series 详情 | 各详情元数据 GET + `useInfiniteVideoList` → VIDEO_LIST | 关联影片每页 200；“加载更多”累积后普通 map | F03，分页不等于 DOM 虚拟化 |
| `PlaylistsPage.tsx:78,137` | preload `:451` → `playlistHandlers.ts:15` → `playlistRepo.ts:118–126` | 全部清单摘要；本地搜索与普通 map | F04，随 P 增长，不附全部清单影片 |
| `PlaylistDetailPage.tsx:75–124,314` | preload `:452–453` → `playlistHandlers.ts:17–24` → `playlistRepo.ts:153–173` | 单清单全部影片，排序重取、本地资源筛选，普通 map | F01，返回/DOM 都随 K 增长 |
| Web `apps/web/apps/desktop/src/main.tsx:613–633,1011–1034` | `apps/web/src/client.ts:13` → HTTP；本次止于客户端 | 用当前响应替换 result；上一页/下一页；普通 VideoGrid | DOM 随当前响应条数增长，不累计历史页；后端 pageSize 上限未审计 |

表内短名的完整主进程目录分别为 `apps/desktop/src/main/ipc/`、`apps/desktop/src/main/services/`、`packages/library/src/db/`；hook/query 为 `apps/desktop/src/renderer/src/query/`。后续证据使用完整路径。

## 发现与建议

### F01 · P1：清单详情一次取得全部影片，排序和返回会再次整包读取

证据链：`apps/desktop/src/renderer/src/pages/PlaylistDetailPage.tsx:75–90` 调用 `api.playlists.get(id, sortBy, sortDir)`，`apps/desktop/src/preload/index.ts:451–453` → `apps/desktop/src/main/ipc/playlistHandlers.ts:17–24` → `packages/library/src/db/playlistRepo.ts:153–173`。SQL 是 `SELECT v.*` 加列表投影、`.all(id)`，没有 LIMIT。`packages/contracts/src/playlistTypes.ts:18–20` 明确返回 `videos: Video[]`。

`PlaylistDetailPage.tsx:121–124` 对整个数组做资源筛选，`:314` 对全部可见影片生成卡片。`:106–110` 从影片栈返回重取，`:92–94` 导入完成重取，`:129–132` 编辑清单后重取，排序依赖改变也触发完整查询。单片移出已有 `:154–156` 本地过滤更新，不能说每种修改都整包刷新。

影响：大清单会同时扩大主进程投影/序列化、IPC 对象复制、renderer 数组与 React DOM，HDD 上可能叠加大量封面读取。只有当清单很大时成立；30 万总影片不证明任何清单也有 30 万。

建议：拆分清单元数据与成员分页接口；将排序、资源筛选放进分页契约，复用虚拟海报网格；单条增删按 ID 更新或只标记当前清单。不得只在 UI `.slice()`，也不得在客户端全量筛选后伪装服务端 total。

验收：构造 200、10,000、300,382 成员的合成清单；打开、换排序、筛选、返回的每次影片返回数均不超过既定页限 200；DOM 上界按视口计算；删除末页最后一条后 total/页位置正确；返回保留 query 与影片锚点。

### F02 · P1：演员详情的关联影片全量返回、全量渲染

证据链：`apps/desktop/src/renderer/src/pages/ActressDetailPage.tsx:104–122` → `apps/desktop/src/preload/index.ts:474` → `apps/desktop/src/main/ipc/actressHandlers.ts:17–19` → `apps/desktop/src/main/services/actressQueryService.ts:84–85` → `packages/library/src/db/actressRepo.ts:550–583`。影片 SQL 有演员 ID 和可见媒体库范围，但没有 LIMIT；写真也一次返回。UI `ActressDetailPage.tsx:452` 直接 `actress.videos.map`。

已有保护是关联范围，不是页大小；普通演员主列表的 240 条分页不能保护详情。`:124–137` 头像保存或从影片栈返回都会再次 load，修改头像也可能重新搬运整部作品集。

建议：演员基础详情与关联影片分离，以演员 ID 过滤的影片分页 + 虚拟网格加载作品；写真独立按需加载，保留可见库过滤。只更新头像时不重取全部关联影片。

验收：单演员 K=0、200、10,000 及异常大关联集下，基础资料载荷不随 K 增长，作品单页 ≤200，卡片 DOM 有界；演员→影片→演员的滚动与排序恢复；头像保存不触发全作品数据返回。

### F03 · P1/P2：分类一级列表无分页，分类详情有分页但 DOM 累积

一级列表（P1）证据：

- `apps/desktop/src/renderer/src/pages/OrganizationListPage.tsx:77–80,187` → `apps/desktop/src/main/services/classificationQueryService.ts:93–145`。
- `apps/desktop/src/renderer/src/pages/DirectorListPage.tsx:51–62,175` → 同服务 `:349–387`。
- `apps/desktop/src/renderer/src/pages/SeriesListPage.tsx:51–54,166` → 同服务 `:501–547`。

三条列表 SQL 均没有外层 LIMIT；封面 fallback 子查询中的 `LIMIT 1` 只限制**每个实体的封面**，不能视作分类列表分页。列表返回的是名称、封面、数量等摘要，已有 DTO 投影，不能称其为全量影片详情。搜索有 250ms 防抖，但空搜索仍返回整个实体集合。

详情（P2）证据：`apps/desktop/src/renderer/src/pages/OrganizationDetailPage.tsx:102–111,350–365`、`DirectorDetailPage.tsx:59–61,258`、`SeriesDetailPage.tsx:85–87,314`。影片复用每页 200 的无限查询，追加后对 `videos` 普通 map。初始有界，点击加载更多后 DOM 随 L 增长至 K，返回影片详情还会 refetch 已加载页。

建议：一级分类列表增加服务端页契约和虚拟网格；详情作品网格复用虚拟海报能力，保留详情滚动容器/嵌套栈语义。元数据详情 GET 本身只取单实体和聚合资料，不应改成全局影片扫描式前端计算。

验收：F=10,000，K=10,000 的合成数据；首屏只回一页实体，深滚/连续加载后的 DOM 不随已读数增长；重命名、合并后按稳定实体 ID 返回，排序并列项不重不漏。

### F04 · P1/P2：选择器的显示限量与传输限量不一致

| 入口与证据 | 实际边界与已有保护 | 优先级 / 建议 |
| --- | --- | --- |
| `apps/desktop/src/renderer/src/components/MergeActressModal.tsx:105–131,259` → `api.actresses.list(search,'all')` → preload `:466–471` → `actressHandlers.ts:8–10` → `actressQueryService.ts:71–72` → `actressRepo.ts:399–407,352–378` | legacy 无 limit；空搜索全演员，回包后按性别过滤，全部候选 map；已有 300ms 防抖及 cancelled 防旧结果写入 | P1；专用限量搜索/分页演员候选，服务端过滤兼容性，保留已选项 |
| `apps/desktop/src/renderer/src/pages/useConflictReviewController.ts:141` → `conflictReviewRemote.ts:53–71` | 同一个 legacy 全量接口；返回后才 slice(0,40)，并有 latest-request gate | P2；40 是显示候选限量，不是 IPC 限量 |
| `apps/desktop/src/renderer/src/components/pluginDev/PluginDevMediaTargetPicker.tsx:22–23,61–85` | 演员先全量 list 再 slice 至 80；影片请求则在 IPC 传 limit=60；250ms 防抖、取消标志 | P2；只修演员候选契约，不扩大到插件运行时审计 |
| `apps/desktop/src/renderer/src/components/AddToPlaylistModal.tsx:32–55,186` → preload `:458–459` 的 listForVideo → `playlistHandlers.ts:40–42` → `playlistRepo.ts:176–192` | 全清单成员关系摘要，本地过滤、普通 map；不是获取每个清单的全部影片 | P2；清单候选分页/搜索，保留 membership 信息 |
| `apps/desktop/src/renderer/src/components/AddVideosToPlaylistModal.tsx:30–53,173` → PLAYLIST_LIST | 全清单摘要，本地过滤；P 很小时成本有限 | P2；与一级清单列表共享候选契约与缓存 |
| `apps/desktop/src/renderer/src/components/ClassificationImageModal.tsx:64,79–84,355–385` → `apps/desktop/src/preload/index.ts:537–538` → `facetHandlers.ts:100–102` 分类候选 handler → `classificationQueryService.ts:59–90` | 默认 file 模式即发候选查询，除隐私条件外未按 mode 限制；所有关联封面候选一次返回、video 模式全 map；图片 lazy 仅延后像素加载 | P1；切入 video 模式再拉第一页，服务端候选页 + 虚拟横向列表 |
| Organization/Director/SeriesPickerField `:31–35 / :26–30 / :21–25`，完整路径 `apps/desktop/src/renderer/src/components/` | `api.*.options` → preload `:502,518,529` → `facetHandlers` → `classificationQueryService.ts:265–297,462–498,643–682`；SQL LIMIT 100，普通 map 最多 100 个候选 | P2 请求频率治理，**不是全量候选问题**；useDeferredValue 不是固定时间网络防抖，缺少 IPC 取消协议 |

分类 options 中每个候选还有别名/角色读取（例如 `classificationQueryService.ts:280–296,485–492,668–680`），次数由 100 条候选限量约束，别名长度仍取决于实体。必要时批量投影；不据此宣称无限 N+1。

标签旁路：`apps/desktop/src/renderer/src/pages/LibraryPage.tsx:272–283` 为名称 Map 获取全部 tags；弹层 `apps/desktop/src/renderer/src/components/TagFilter.tsx:102–107` 又独立加载一次。preload `apps/desktop/src/preload/index.ts:494–497` → `apps/desktop/src/main/ipc/facetHandlers.ts:109–112` → `apps/desktop/src/main/services/tagQueryService.ts:9–11` → `packages/library/src/db/tagRepo.ts:18–37`，无分页并返回使用计数。TagFilter `:128–135` 在本地过滤、紧凑模式排序后才截取 200；所以**候选 DOM ≤200，IPC/排序仍随 T 增长**，选中 chip 另随选中标签数增长。建议共享标签查询、按 ID 补取已选名称、分页搜索；不能只去掉显示截断。

验收：空搜索、大量同名前缀、多性别、已选项不在当前页、旧请求晚到；逐个断言服务端返回上限及 payload，不能只验 DOM 条数。取消关闭弹窗后不得写入旧结果；不要求本次实现。

### F05 · P1：全局侧栏用完整待确认快照轮询徽标

`apps/desktop/src/renderer/src/components/Layout.tsx:169–179` 每 3,000ms 调 `api.scrape.listPending()`，只用数组长度计算侧栏徽标。真实链路：`apps/desktop/src/preload/index.ts:560` → `apps/desktop/src/main/ipc/scrapeHandlers.ts:90–91` → `apps/desktop/src/main/services/scrapeJobController.ts:267–268` → `apps/desktop/src/main/services/videoPendingScrapeService.ts:131–133` → `packages/library/src/db/pendingVideoScrapeRepo.ts:360–367`。

该仓储先取全部 pending ID，再逐个 `getPendingVideoScrapeById`；返回含候选 `result_json` 解析结果和暂存资源路径（`:246–276`），并不是 count DTO。单次返回随 Q 及其候选/资源数增长。即便用户只浏览影片、待确认页没打开，也会触发这条请求。3 秒是配置周期，不是实测频率；请求去重、耗时和窗口状态会影响实际次数。

同处 `Layout.tsx:158–172` 还轮询演员冲突摘要和媒体库摘要。`ActressesPage.tsx:175–178` 使用相同 conflictSummary key，详情打开时停止该页面 interval，但 Layout 的观察者仍在；不能把两个 observer 直接相加成两倍 IPC，也不能认为页面停轮询就等于全局停轮询。

建议：徽标用 count/summary 契约；待确认页独立使用分页队列摘要，选中后再取候选详情；事件标记变更版本，辅以低频兜底同步。避免仅把 3 秒改得更长而保留整包搬运。

验收：Q=0、1,000、10,000，徽标接口始终返回固定字段，无候选 JSON/资源列表；桌面空闲期间无完整 pending-list 轮询；完成/丢弃后数量最终一致。记录请求数和响应字节，不把“页面不卡”作为唯一通过条件。

### F06 · P1（触发时）：演员头像筛选的分页响应掩盖全候选检查

`apps/desktop/src/main/services/actressQueryService.ts:90–142`：普通 `avatar='all'` 和 `without-face` 直接走分页仓储；`with/without` 分支若有显式 limit，则首次把 `limit` 去掉，取得全部候选，逐个 `inspectImage`，建立快照再 slice。offset=0 总是重建，后续页复用；最多保留 8 个查询快照（`:44,101–109,129–141`）。**页响应有界，快照内容与首次工作量随 A 增长**，8 是快照个数上限，不是演员行总量上限。

图片检查终点 `apps/desktop/src/main/services/mediaAssetStore/inspection.ts:37–65` 对非空路径先 `statSync`；缓存未命中才读文件、检查和生成指纹。`apps/desktop/src/main/services/assetCache.ts:73–99` 已有签名检查缓存，但仅 256 项；超大候选集合重扫不能保证命中，命中也仍先做 stat。HDD 上有放大同步文件访问的明确机制，具体延迟未测。

“无人脸”另有路径：`apps/desktop/src/renderer/src/actressFaceFilter/manifestQueryOptions.ts:8–11` 明确 `enabled:false, staleTime:Infinity`，普通演员页不会自动拉 manifest。用户开始扫描时 `useActressFaceScan.ts:110–129` 才 refetch → preload `:473` → `actressHandlers.ts:14–16` → `actressQueryService.ts:74–82` 全候选检查并返回 manifest；检测后把 ID 子集供列表分页。`scanQueue.ts:86–119` 已逐项检测、复用指纹缓存、检查取消，`useActressFaceScan.ts:75–83` 离页取消；不能称为无控制的并发人脸扫描。

额外按需全量路径：`apps/desktop/src/renderer/src/contexts/AvatarAutoCropBatchContext.tsx:346–357` 的“统计所有头像”和“开始所有头像”均先 legacy list 全演员，count 不是轻量计数 API。不是普通浏览必然触发。

建议：头像可用性/指纹采用可增量维护的读模型或独立受控任务；分页筛选读取状态，陈旧状态允许异步更新；manifest 分批传输并维护 session 版本，停止时可取消未执行工作。第一步先增加诊断数据与显式工作进度，不破坏“失败图片不算有头像”和指纹失效语义。

验收：普通首屏不调用 manifest、不做 A 次图片检查；with/without 冷首屏、跨页、返回、缓存失效均单独记录 stat/读文件次数；对 10,000 有头像演员验证分页中不重复全候选扫描；取消后不继续启动新检测。不得套用历史无头像基准作为通过证明。

### F07 · P1：无限查询无保留页预算，返回与全域 invalidation 扩大刷新集合

数据保留：`apps/desktop/src/renderer/src/query/useInfiniteVideoList.ts:29–55`、`actressInfiniteQueryOptions.ts:19–29`、`useInfiniteActressList.ts:43–46`、`apps/desktop/src/renderer/src/pages/HomePage.tsx:119–137`、`GlobalSearchPage.tsx:61–85` 都保留 pages，再 flatMap。没有 maxPages/窗口预算。flatten 新建的是数组引用容器，不能算成再次深复制每个 DTO；但结果对象、额外 Map、跨查询 key 的数据都会占用内存。

全局策略 `apps/desktop/src/renderer/src/query/queryClient.ts:3–11` 是 staleTime=5 分钟、gcTime=30 分钟、失焦返回/重连时允许 stale 查询刷新、retry=1；gcTime 针对不活跃查询，不是活跃列表的内存硬上限。首页快照 30 秒、首页搜索 15 秒，未刮削计数 5 秒，Layout 库摘要 2 秒等覆盖默认值。

刷新调用链：

1. `apps/desktop/src/renderer/src/query/QueryProvider.tsx:9–13` 挂根 `LibraryDataSync`；`apps/desktop/src/renderer/src/hooks/useLibraryDataSync.ts:94–102` 在进入列表根时调用 `refetchStaleLibraryQueries`。路由判断 `apps/desktop/src/renderer/src/lib/librarySurfacePaths.ts:39–45` 是“非列表根→列表根”，包含关闭详情与设置返回，跳过列表根之间切换。
2. `apps/desktop/src/renderer/src/query/invalidateLibraryQueries.ts:49–56` 对 videos、actresses、organizations、directors、series、overviewStats 使用 `type:'all', stale:true`。会涉及仍在缓存中的不活跃旧筛选，**不是只刷新当前可见列表**。这段不含 home 前缀，不能误称所有首页搜索也由这次路由函数刷新。
3. `apps/desktop/src/renderer/src/hooks/useListSurfaceRefetch.ts:4–12` 关闭详情无条件调用页面 refetch。媒体库 `LibraryPage.tsx:394–398`、演员 `ActressesPage.tsx:183–188`、三个分类详情均使用它；fresh 数据也会请求。与路由 stale 刷新可能重合，实际去重/取消时序需请求 trace，不能静态宣称必定双发。
4. `apps/desktop/src/renderer/src/query/invalidateLibraryQueries.ts:14–45` 修改/扫描按多个根 key 失效；默认活跃查询刷新，旧筛选先 stale，再可能被步骤 2 拉起。后台隐藏但仍挂载的列表也可能保持活跃。

本地安装的依赖实现 `node_modules/@tanstack/query-core/src/infiniteQueryBehavior.ts:94–107` 使用 oldPages.length 循环 refetch 页面（提前无下一页则停止）。这是本地依赖观察，不作为仓库生产源码行号；后续复测应固定 lockfile 版本。已加载 k 页的列表刷新可能重新执行 k 次分页调用及计数。以 200 条页限计算，完整遍历 300,382 条需要 1,502 页，**只是上界算术，不代表用户已遍历或当前首屏发出 1,502 请求**。

已有缓解：`useLibraryDataSync.ts:15–48,70–90` 批进度失效有 1 秒 trailing debounce，finish 立即失效、scan 只在 completed/failed 全失效，不能称每个进度事件都全库 refetch。`ListDetailShell.tsx:11–31` 保持列表挂载，保护滚动/筛选，不能为省内存随意改成卸载；需要协调数据窗口与恢复策略。

建议：以可见 surface + scope + 实体类型缩小 invalidation；详情只读返回不无条件刷新，修改时按 dirty/version 刷新相关页；取消 type:all 的历史查询主动刷新；定义活跃页窗口和不活跃缓存预算。**不能直接加 maxPages=N 就结束**：当前 offset 根据“保留页条目总数”计算，淘汰前页后会回退重复请求，还会使绝对滚动位置/Shift 选择失效。需独立 nextOffset/cursor、绝对索引、页窗口锚点与前向/回退加载设计，再落实预算。

验收：加载 1/10/100 页，切换 20 个筛选后往返详情/设置；只读返回不重拉全部已读页，旧不可见筛选不被路由主动刷新；更新后可见计数/卡片正确；缓存页数在设定预算内稳定，前页淘汰后继续加载不重不漏，返回可恢复锚点。记录 active/inactive key、页数、每次 handler 调用，不只看缓存命中率。

### F08 · P2：分页 DTO 仍宽，不能把条数上限当作字节上限

`packages/library/src/db/scopedVideoCatalogRepo.ts:375–381` 使用 `v.*`；`hydrateRows :304–326` spread 保留字段。`packages/contracts/src/videoTypes.ts:101–129` 包含 summary、original_title、多个名称和时间等，`packages/contracts/src/catalogTypes.ts:15–18` 还附跨库 badges；列表不含详情专属 resources/tags/assets 全对象，已有“列表/详情”分层，需在该基础上收窄。`scopedVideoCatalogRepo.ts:141–155` badges SQL 没有数量 LIMIT，每行随影片的库成员关系数增长。

演员列表 `packages/library/src/db/actressRepo.ts:359–378` 同样 `a.*`；`packages/contracts/src/actressTypes.ts:20–43,75–78` 的 ListItem 继承个人简介、裁剪 JSON 等完整 Actress 字段。清单/演员作品集的 `v.*` 使 F01/F02 的大数组更宽。

建议：显式 `VideoCardDTO / ActressCardDTO / CandidateDTO` 投影；字段以实际卡片消费为准，简介/原始编辑数据按单实体 GET。需要支持多库标识时可传有限可见摘要及总数，或共享库字典；任何截断必须保留正确的点击作用域。类型裁剪不等于运行时裁剪，必须同步改 SQL/映射。

验收：固定 200 影片与 240 演员页，加入超长简介/裁剪 JSON/多库关联的合成样本；断言列表不携带无用长字段，逐页记录 JSON UTF-8 估算字节及 IPC 耗时。JSON 长度只是可复现代理，不能冒充 Electron 实际传输字节或堆大小。

### F09 · P1/P2：图片按原文件同步服务；虚拟化之外的图片需求仍可放大

准确链路：`apps/desktop/src/renderer/src/components/PosterCard.tsx:63,146–150` → `apps/desktop/src/renderer/src/api.ts:5–9` 的 `media://` URL → `apps/desktop/src/main/appMain.ts:134–160` → `apps/desktop/src/main/services/mediaAssetStore.ts:190–191` → `apps/desktop/src/main/services/mediaAssetStore/filesystem.ts:69–77`。每次到达 handler 都 existsSync/readFileSync，必要时解密，然后整 Buffer 返回；该链路没有缩略图尺寸参数、异步流式读取或字节缓存调用。这里是桌面资源协议，不是 Web 后端。

`apps/desktop/src/main/services/assetCache.ts:26–70` 定义了 256 项/96MiB 字节缓存函数，但本次全 `src` 搜索 `getCachedAsset/setCachedAsset` 只命中定义，**当前 media:// 服务链未使用它们**。同文件的 imageInspectionCache 在 F06 链路确实被使用。浏览器/OS 缓存可能避免部分真实磁盘 I/O，不能把每个 img 都断言为物理盘读取，也不能把未接线工具当作已有热图保护。

已有保护与边界：

- 海报有 loading=lazy，主列表虚拟化限定挂载数；`VirtualPosterGrid.tsx:270–293`、`VirtualActressGrid.tsx:146–165`。封面固定布局不等于解码尺寸变小。
- `apps/desktop/src/renderer/src/components/ActressAvatar.tsx:27–49` 有失败占位和隐私默认头像，但无 loading=lazy；主列表虚拟化可限量，演员合并等全量候选会放大请求。
- `VideoSampleGallery.tsx:207–224`、`ActressGalleryPanel.tsx:222–245`、`ImagePreviewLightbox.tsx:702–718` 有 lazy，却仍生成全部该实体的样张/写真/缩略项 DOM；成本随图库规模，不随总影片数必然增长。
- `AppBackgroundLayer.tsx:82–103` 用 new Image 探测尺寸，`:112–114` 清理 ResizeObserver；同 URL 后续显示是否共享请求由浏览器决定，不能断言下载两次。`Layout.tsx:155–156` 预览/隐私模式关闭背景来源，已有减载。

建议：P1 先测并改进 HDD 上的同步原图服务边界；列表使用按展示尺寸分档、可失效的派生缩略图，限制生成/读取并发，保留原图供预览；让主进程避免同步长文件操作。P2 再处理超大图库 DOM 和头像懒加载。缩略图缓存按字节预算/版本/隐私及加密语义设计，不建议一次为全库生成全部图片。

验收：使用普通色块生成大分辨率图片，分别测试冷/热、加密/未加密、缺失/损坏、快速滚动与返回；记录请求量、文件读取量、解码像素、主进程阻塞和 renderer 内存。列表读取派生尺寸，原图仅预览按需读取；重复热图请求命中可验证缓存；恢复/换图后无陈旧图像。

### F10 · P2/P3：事件清理已有实现，但进度广播、批量动作和请求竞态仍需约束

事件不应泛报成泄漏：preload `apps/desktop/src/preload/index.ts:177–201` 的事件 helper 返回 removeListener；根 `apps/desktop/src/renderer/src/contexts/BatchScrapeContext.tsx:48–60` 对影片/演员各订阅一次并清理，`:63–74` memoize context value。`apps/desktop/src/renderer/src/hooks/useLibraryDataSync.ts:84–93` 返回 scan 取消订阅。`PosterCard.tsx:85–92` 仅菜单打开时安装 pointerdown，关闭清理，不是每张卡片常驻一个 window pointerdown。

剩余风险：

- 每个 batch progress 都 setState，所有消费同一 context 的组件可随进度重新 render；1 秒失效 debounce 不等于 render 节流。P3，先量实际 commit 次数，再考虑状态切片/进度展示采样；本次不审计进度产生端的频率。
- `apps/desktop/src/renderer/src/components/VirtualPosterGrid.tsx:167,292` 与 `VirtualActressGrid.tsx:103,164` 在父 render 内定义 Cell；innerElementType 也随总高度改变（前者 `:120–135`，后者 `:77–92`）。有组件类型变化导致可见项重挂载的风险，即便 DOM 数量有界。P2，通过 Profiler/mount 计数验证后再将单元组件与 itemData 稳定化，保持尺寸恢复行为。
- `apps/desktop/src/renderer/src/pages/LibraryPage.tsx:576–585,650–659` 对选择集用 Promise.all 逐个请求删除/移库影响，瞬时并发随 S 增长。`apps/desktop/src/renderer/src/components/AddVideosToPlaylistModal.tsx:57–63` 则逐影片 await addVideo，是串行 S 次 IPC；不能称其并发风暴。建议批量预览 DTO + 有界分块，写入批接口保留部分失败语义。
- `apps/desktop/src/renderer/src/hooks/useRangeSelection.ts:32–48` 的 Shift 选择只覆盖已加载 items，切 query 清空（`:28–30`）；没有证明一次自动选中全库。深浏览后的大 S 仍需预算，不能把选择范围 silently 截断。
- 影片/演员/清单详情的手写 load 在 `DetailPage.tsx:248–281`、`ActressDetailPage.tsx:104–122`、`PlaylistDetailPage.tsx:75–90` 没有 request sequence/abort gate；快速切实体或排序时，旧响应可能覆盖新状态。HDD 可能加大竞态窗口，但未实测触发。已有 selector cancelled/gate 只防落地，不能取消已经执行的 IPC/SQL。共享无限查询 queryFn 也不向 preload 传 AbortSignal。

验收：用模拟 API 延迟逆序响应验证最后一次选择获胜；开关页面/弹窗 100 次后 listener 数回到基线；100 页后刷新/选择动作测卡片 mount 与 commit 次数；大 S 批量操作验证有界 in-flight 数、进度和失败重试。避免在用户库执行删除试验。

## Web UI 专项（不含 Web 后端）

`apps/web/apps/desktop/src/main.tsx:613–633` 请求 `/api/videos` 时先清 result，再 setResult(value)，cleanup abort 且检查 aborted；`:1011–1034` 用上一页/下一页替换数据，`:480` VideoGrid map 当前集合。**没有无限追加历史页的路径**，不能因为普通 map 就判定渲染所有 300,382 条。客户端也没有自行 slice response；服务端实际页上限在本次范围外，不声称已验证具体数值。

仍需覆盖的 UI 风险（P2）：

- 媒体库/清单 collections 一次存入状态（`:601–612`），移动选择弹层 `:827–831` 和侧栏 `:859,876` 映射全部项目，DOM 随库数/P 增长。应对大量清单增加搜索/分段呈现或虚拟选择器，保持模态焦点规则。
- 单影片详情演员/标签/图片 `:422,430,453–460` 都全 map，图片 lazy；这是单影片关联集合边界。头像在 `:196` 已设置 lazy + async decoding，比桌面通用头像更完整。
- `apps/web/src/navigation.ts:127–141` 每次方向导航遍历文档候选，检查可见性及 getBoundingClientRect；大 collections 或详情图库会放大按键工作。`main.tsx:1089–1090` 已注册/清理唯一顶层 keydown。建议先测候选数量与布局成本，再按导航组索引和缓存几何；需在 resize/滚动/DOM 更新后失效，不能牺牲正确焦点导航。
- 翻页/离页已有 AbortController；`apps/web/src/client.ts:36,54` 清理父信号 listener。不把这条链路混同桌面不可取消的 invoke。

验收遵守移动规范：320×844、390×844、844×390、1280×800，普通模拟影片数据；单页替换后 DOM 不累计；大 collections 搜索与焦点恢复正确；返回恢复来源卡片/滚动；真正按方向键验证延迟与焦点。Web 后端 SQL、文件服务、分页大小和连接并发留给独立审计。

## 实施顺序与交付切分

| 阶段 | 具体交付 | 对应发现 | 完成条件 |
| --- | --- | --- | --- |
| 0：建立证据基线 | 独立合成数据/模拟 API；记录每 surface 的 handler、返回条数/估算字节、缓存页数、DOM、主/渲染进程 profile | 全部 | 能区分查询等待、IPC 搬运、React commit、图片读取；不读取用户 DB |
| 1：封住最大返回旁路 | 待确认 count；清单/演员详情成员页；演员候选页；分类封面候选按 mode 懒查询并分页 | F01/02/04/05 | 空闲不搬完整 pending；所有高基数成员/候选入口有服务端页上限 |
| 2：限制 DOM 和缓存刷新 | 分类一级分页、详情虚拟化；scope/version 定向失效；设计页窗口与锚点恢复 | F03/07/10 | 深浏览 DOM 有界、缓存有预算；只读返回不扫描所有旧 key；选择/嵌套路由不回退 |
| 3：降低 HDD 图像阻塞和 DTO 字节 | 卡片 DTO；图片尺寸分档、异步受控服务；头像检查增量化 | F06/08/09 | 无首屏全候选图片检查；分页载荷剔除长详情字段；热图路径实证命中缓存 |
| 4：长尾交互 | 标签共享候选、清单选择器、超大图库、Web collections/导航、批量动作/进度节流 | F04/09/10、Web | 高频键盘/搜索/选择动作预算稳定，listener 回收、旧响应不落地 |

阶段允许并行设计，但成员分页/页窗口先定契约再替换 UI。不能先裁掉数据却保留基于 loaded.length 的 offset；不能只虚拟化全量 DTO；不能通过卸载 ListDetailShell 破坏现有返回栈来“修复”性能。组件继续采用语义 token、现有滚动 surface、紧凑 toolbar 与可撤销 query chip。

## 可执行验收方案与测量记录模板

以下是**待执行计划与建议门槛**，不是本次测量结果。测试环境应单独建立，不运行应用默认 userData；生成普通占位影片/色块图片，确认所有数据库/资产路径指向测试目录，再执行应用测量。数据库约 1 GB 需通过字段/关联/索引分布构造并报告实际大小，不能仅凭记录数宣称复现该规模。

| 场景 | 合成数据与操作 | 必须收集 | 结构性通过条件 |
| --- | --- | --- | --- |
| 首屏与搜索 | N=1,000 / 10,000 / 300,382；空/宽/窄搜索，10 次快速换词 | 发出/完成/丢弃请求数、行数、估算字节、首可交互时间 | 媒体库≤200、搜索≤120、演员≤240；最后 query 获胜，无全量旁路 |
| 深浏览 | 1/10/100 页，回滚、切详情、返回，20 个筛选 | query key/页/行数，heap、DOM、commit、重挂载、refetch 页数 | 虚拟网格 DOM 由视口公式约束；新页预算稳定、锚点可恢复 |
| 热点实体 | 大 K 清单/演员/分类，F=10,000；长文本 DTO | 每接口 count/limit、IPC 载荷、元素数 | 基础详情与 K 解耦；关联页≤200；所有候选限量在 IPC 之前 |
| 待确认积压 | Q=0 / 1,000 / 10,000，停留普通影片页 | 轮询接口名/次数/字节、候选展开量 | 徽标只读摘要；普通页面不拉候选明细 |
| HDD 图片 | 冷/热、大图、缺失/损坏、加密，with/without 头像筛选 | stat/read 次数、字节、排队、主线程阻塞、图片解码、缓存命中 | 页内图像按需；命中路径可解释；无全候选首屏同步扫描 |
| 事件与批量 | 批进度、scan 结束、100 次进出弹窗、S=1/200/大选择集 | listener、commit、IPC in-flight、更新范围 | 清理回基线；并发有固定上限；最终状态一致且可重试 |
| Web UI | 小页/大量 collections/大图库，四种规范视口 | 当前 DOM、键盘几何查询数量、焦点与滚动 | 翻页不累计 DOM，模态/返回/方向导航行为正确 |

虚拟网格 DOM 建议用 `列数 × (可见行数 + 实际缓冲行数) + 状态单元` 验证，不将历史“约 80”硬套所有窗口、缩放和卡片模式。性能数字在基线后由目标 Windows HDD 环境制定：分别报告中位数/p95、样本数、离群值、冷/热定义与硬件；不要用一个平均耗时替代渲染与交互体验。

建议诊断记录字段：`commit / build / OS / CPU / RAM / HDD型号与路径 / 数据量及分布 / 图片尺寸与加密状态 / 场景 / 缓存状态 / handler / scope / queryHash / limit / offset / 返回条数 / JSON估算字节 / 主进程执行时间 / invoke往返时间 / React提交时间 / 长任务 / DOM数 / heap / active与inactive页数 / 图片读取数与字节`。SQL handler 时间、invoke 往返与 React commit 分段记录，不能把往返差值直接命名为纯序列化时间。只对合成数据记录查询参数，日志不要采集用户标题/路径。

回归必须包含 stable ID 与相同排序值、空页/末页、下一页失败重试、数据变化导致 total 改变、隐藏/归档库、跨库 badges、跨页选择、只读/修改后两种返回路径。现有 `apps/desktop/src/renderer/src/query/useInfiniteVideoList.test.tsx`、`actressListBehavior.test.ts`、`actressListPages.test.ts`、`apps/desktop/src/renderer/src/components/actressGridLayout.test.ts` 可作为正确性测试入口；本次未执行这些测试或新增脚本。

## 历史基准、已确认保护与未决事项

[演员分页基准](actress-list-pagination.md)记录的是 2026-08-07 的 Windows、10,000 位女性演员、无头像与影片关联、预热后 5 次查询：44.97ms→6.23ms、首返 10,000→240、特定视口 DOM 约 80。这里仅引用原文用于确认已有优化，**不能外推为 300,382 影片/1GB/HDD 的性能结果，也不能用于头像扫描或演员详情**。

已经确认的保护应继续保留：影片每页服务端最大 200；普通演员分页和虚拟网格；搜索防抖；候选 options 的服务端 100 上限；TagFilter 的 200 候选 DOM 限制；分页失败保留旧页；列表常驻与滚动恢复；根事件清理；批次失效 debounce；人脸扫描显式启动、串行检测和取消；海报/图库 lazy；Web 分页替换和 abort。

未决事项：用户真实 K/A/F/P/Q/T 分布、数据库与图片是否同盘、Windows 内存/磁盘型号、冷启动与常驻行为、浏览器图像缓存实际命中率、慢查询执行计划、渲染/主进程时间占比均未测。当前证据支持实施上述有界化计划，不能据此给出提速倍数、绝对耗时、内存节省量或断言 Issue #100 的唯一根因。

本次工作为文档审计，不包含生产修改、性能压测结果、GitHub 发布或用户数据库操作。


AR实施备注：演员冲突后端已提供概要page和单组get，详见实施记录；当前页面仍未迁移，原全量actor旁路继续算未完成。normalizedName路由身份保留完整，显示名截断不能用来证明固定字节预算。单组完整资源/合并预检规模、跨页确认与恢复仍须后续验收。
