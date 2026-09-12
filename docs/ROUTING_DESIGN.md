# Routing Design

本项目的路由目标是保留用户正在浏览的列表上下文，让详情、嵌套详情和返回行为都可预期。路由不是单纯表达资源 ID，也表达“从哪个列表面打开”。

## Core Model

- `ListSurface`: 可滚动、可筛选、需要保留状态的列表面，例如媒体库、演员、清单、分类。
- `DetailSurface`: 从列表面打开的详情面，例如影片详情、演员详情、分类详情、清单详情。
- `OverlayStack`: 在详情面内继续打开另一层详情，例如影片详情中打开演员，演员详情中打开影片。

`ListDetailShell` 是列表常驻模型的边界。列表面必须保持挂载，以保留滚动位置、筛选状态、虚拟列表测量和已加载数据。

## Route Semantics

当前路由使用嵌套路径表达上下文：

- `/`: 首页，展示跨媒体库即时搜索、随机推荐与近期添加；存在 `q` 时原地切换为搜索结果列表。
- `/home/video/:videoId`: 从首页打开影片详情。
- `/home/video/:videoId/actress/:actressId`: 从首页影片详情继续打开演员详情。
- `/search`: 跨媒体库搜索结果列表。
- `/search/video/:videoId`: 从全局搜索打开影片详情。
- `/search/video/:videoId/actress/:actressId`: 从全局搜索影片详情继续打开演员详情。
- `/libraries/:libraryId`: 一个媒体库的独立影片列表。
- `/libraries/:libraryId/video/:videoId`: 从指定媒体库打开影片详情。
- `/libraries/:libraryId/video/:videoId/actress/:actressId`: 从库内影片详情继续打开演员详情。
- `/settings/library/:tab?library=:libraryId`: 全局设置工作区内的媒体库设置，位于“概览”之后；默认 `sources` 页合并来源管理与扫描导入。
- `/libraries/:libraryId/settings/:tab`: 旧媒体库设置入口，仅兼容重定向到全局设置工作区。
- `/library` 与旧 `/detail/:id` 只是兼容入口；它们会解析可用媒体库并重定向到上述新路由。
- `/actresses`: 演员列表。
- `/actresses/:id`: 从演员列表打开演员详情。
- `/actresses/:id/:videoId`: 从演员详情打开影片详情。
- `/playlists`: 清单列表。
- `/playlists/:playlistId`: 清单详情。
- `/playlists/:playlistId/:id`: 从清单详情打开影片详情。
- `/pending`: 待确认收件箱，收拢扫描资源归属、影片刮削候选与演员名称冲突三类决定。扫描组合队列使用 `scanOffset`，刮削队列使用 `scrapeOffset`，演员队列使用 `actressOffset` 保存分页位置；扫描 `item=scan:<id>` / `item=scan:identity-<id>` 在所选 `lib` 的活动库范围内定位。`item=scrape:<id>` 或 `videoId` 深链接由服务端定位所在页，删除后的越界页回退到最后一页。演员 `item=actress:<normalizedName>` 使用完整名称定位所在页；`queue` 标记翻页目标领域，避免全部视图跳到其他队列。列表只读概要，URL 选中项及分页偏移规范化后才加载单项候选详情。
- `/actresses/conflicts`: 旧的演员冲突入口，重定向到 `/pending?type=actress`。
- `/pending/video/:videoId`: 从待确认工作台打开影片详情。
- `/pending/video/:videoId/actress/:actressId`: 从待确认影片详情继续打开演员详情。
- `/pending/actress/:actressId`: 从待确认工作台直接打开演员详情，返回仍落在待确认收件箱。
- `/facet/:type`: 分类列表。
- `/facet/:role/o/:organizationId`: 制作商或发行商实体详情。
- `/facet/director/d/:directorId`: 导演实体详情。
- `/facet/series/s/:seriesId`: 系列实体详情。
- `上述实体详情路径/:id`: 从分类实体详情打开影片详情。
- `.../actress/:actressId`: 从影片详情继续打开演员详情。

分类详情只使用稳定实体 ID。旧的 `/facet/:type/v/:valueKey` 名称路径不提供兼容入口，避免重命名、合并或同名实体导致导航偏移。

不要把所有影片详情强行规约到单一 `/videos/:id`。影片详情需要知道打开来源，才能返回原列表、保留筛选参数和维持用户的扫描位置。

## Query State

列表筛选、排序和搜索属于 URL query state。它们应该满足：

- 可复制：复制当前 URL 能恢复筛选条件。
- 可替换：输入搜索、筛选变化使用 `replace`，避免污染浏览历史。
- 可撤销：已应用筛选必须在页面上以 chip 呈现，并支持单项移除；搜索词由常驻搜索框呈现和清除，不重复显示为 chip。
- 可复用：列表导航 helpers 应传递当前 `location.search`，除非业务明确需要清空。

新增列表参数时，应先扩展 `listQueryParams.ts`，再由页面消费。不要在页面里手写分散的 query key 字符串。

首页和全局搜索的影片详情路径不含媒体库 ID，因此用 detail-only `lib` query 保存本次打开时选中的资源作用域。`lib` 不改变列表结果，返回列表前必须移除；`/libraries/:libraryId/...` 由 pathname 持有作用域，不应保留冗余 `lib`。全局搜索的 `libraries` query 则是可共享的结果集筛选。

待确认收件箱把队列筛选和当前选中项也放在 URL：`type` 是领域筛选（`all`/`scan`/`scrape`/`actress`），`item` 是 `domain:id` 形式的选中项。两者由 `pendingRoutes.ts` 统一构造与解析，页面不拼接 key。

### Query Scope

列表 query 分为两类：

- Shareable state: 改变列表结果集或排序的条件，例如搜索词、性别、标签、状态、年份、番号前缀、排序方式。应写入 URL query。
- Ephemeral state: 不影响结果集或只影响当前交互的状态，例如 popover 开关、modal 开关、批量选择、正在加载的目标 ID。应保留在组件 state。

一级列表之间导航时，应保留当前列表自己的 query。切换到不同资源类型时，不继承不相关 query。分类类型切换是资源类型切换，应清空旧分类的 query，避免把导演搜索词带到制作商列表。

### Primary nav memory

侧栏主导航与列表 query 的约定：

- **跨一级列表**：恢复该列表上次*离开时*的 query（写入发生在离开根路径时，而不是每次 search 变化）。
- **再点当前一级列表**：不修改 query。已在列表根时仅清除滚动记忆（回顶）；若在详情栈则回到列表根并保留当前 `location.search`。
- **清空 query**：只通过列表筛选重置；重置时应 `forget` 该根的导航记忆，避免之后跨分区又带回旧筛选。
- 分类类型之间切换仍不继承对方 query。

清单列表搜索也属于 Shareable state，使用 `q` query；服务端分页位置使用 `playlistOffset`，打开详情与返回时保留，修改搜索时重置。

搜索词虽然使用 `q` query，但它属于 toolbar search state，不属于 `AppliedFilterBar` 的筛选 chip state。

## Navigation Helpers

业务代码不应直接拼复杂路径。优先使用 helper：

- `navigateToVideoDetail`: 从当前上下文打开影片详情。
- `navigateBackFromVideoDetail`: 关闭影片详情并回到原列表面。
- `navigateToActressFromVideoDetail`: 在影片详情中打开演员详情。
- `navigateToOrganizationDetail` / `navigateToDirectorDetail` / `navigateToSeriesDetail`: 打开稳定分类实体详情。
- `navigateToVideoListSurface`: 回到当前媒体库列表；没有库作用域时回首页。
- `navigateToActressList` / `navigateToFacetList` / `navigateToPlaylistList`: 回到对应一级列表。

新增路由时，按职责分层：

- route patterns: 供 `Route` 和 `useMatch` 使用。
- route builders: 生成 pathname。
- route parsers: 从 pathname 恢复上下文。
- navigation helpers: 表达用户意图，不暴露路径细节。

## Scroll And Refetch

列表面滚动位置需要绑定到稳定 key。key 应包含列表作用域和影响结果集的筛选 hash，例如 `library:${libraryId}:${queryHash}`、`global-search:${queryHash}` 或 `organization:${role}:${organizationId}:${queryHash}`。

详情关闭或嵌套层关闭后，列表面应静默刷新数据，而不是重新挂载列表。`useListSurfaceRefetch` 用于这个场景。

## Adding A New Surface

新增列表/详情组合时遵循这个顺序：

1. 在路由 pattern 中定义匹配规则。
2. 增加 path builder 和 parser。
3. 用 `ListDetailShell` 包裹列表面。
4. 列表筛选进入 URL query。
5. 列表滚动使用作用域化 memory key。
6. 返回按钮调用对应 navigation helper。
7. 详情嵌套时使用 `detail-pane--stacked` 和 `detail-pane-overlay`。

## Route Change Checklist

- `App.tsx` route tree、route match pattern、path builder、path parser 同步更新。
- reload reset 逻辑复用 parser 或 route helper，不新增孤立 regex。
- route match 常量维护在 `apps/desktop/src/renderer/src/listView/routePaths.ts`（`ROUTE_MATCH`）。
- 打开详情时保留 `location.search`，除非明确进入另一类资源。
- 关闭详情时回到打开来源，而不是统一回到媒体库。
- 新增嵌套详情时同时补充 background scope、scroll/refetch 行为和返回按钮行为。

## Settings History

设置工作区使用 Data Router 的 hash history，使 `SettingsLeaveGuard` 能统一阻止未保存表单的路由跳转。应用根由 `createHashRouter` / `RouterProvider` 提供，原有 `App` 内嵌路由树继续负责页面布局。

设置子页统一写入路径：`models/usage`、`models/providers`、`models/advanced`；`plugins/video`、`plugins/actress`；`storage/assets`、`storage/export`。媒体库作用域继续使用现有 query，构建目标路径时保留该作用域，不在子面板维护第二套页签状态。

## Overlay History

需要响应系统后退、鼠标返回键或 macOS 返回手势的全屏 overlay，不能在组件 Effect cleanup 中直接调用 `history.back()`。History 所有权、实例 token、关闭来源和跨平台测试规范见 [`IMAGE_PREVIEW_HISTORY_DESIGN.md`](IMAGE_PREVIEW_HISTORY_DESIGN.md)。

### 清单、分类与关联影片连续浏览

清单、导演、系列和机构主列表使用后端分页与 `ContinuousGrid`。清单影片、分类关联影片和演员作品使用 `ContinuousPosterGrid`，在详情已有的滚动容器中计算可见区域，不再设置第二层影片滚动条。接口仍按现有页大小读取；每个挂载列表只留最近需要的三页。

`playlistOffset`、`facetOffset`、`relatedVideoOffset` 兼容已有链接，作为初始条目位置。滚动同步使用 replace；偏移不参与列表数据会话标识，不能因为位置更新重建窗口。搜索与排序改变时回到列表起点；分类 role 切换同时清空旧搜索。搜索草稿绑定 navigation key、pathname 和 query，导航后旧 debounce 不得改写新 URL。

列表在详情返回时按条目位置与行内偏移恢复；窗口列数变化时重新计算位置。读取错误保留列表高度和已加载页，由列表区域提供重试。删除、合并导致总量下降时校正到有效范围并刷新保留页。旧会话请求即使不能取消，也不能写入新列表。

待确认中心的 `scanOffset`、`scrapeOffset`、`actressOffset`、扫描历史、审计明细及演员写真仍使用显式分页。本次不改变 Web 路由或写真跨页预览。验证方法与范围见[连续浏览验证记录](performance/desktop-continuous-browsing.md)。

### 主网格窗口与跨页选择

媒体库、演员、首页搜索及全局搜索使用 `useWindowedCatalog`。网格高度和事件索引按服务端总量及绝对位置计算，不能用当前保留的 `items.length` 推导下一页偏移或选择索引。每个挂载列表保留最多3页，不活跃页 `gcTime: 0`；滚动及读取锚点各最多20个轻量条目。返回旧位置时按需补读，后续页失败不能卸载整个网格，首屏失败提供明确重试。

卡片数据在进入查询缓存前投影并检查单页1 MiB JSON编码预算；宽详情仍由GET读取。仅选中ID独立于卡片缓存。Shift采用半开绝对范围，逐页获取ID并比较读取修订、总数和端点；取消或结果变化不提交部分范围。只读返回仅刷新活动且过期的查询，不遍历已淘汰历史页。

导演、系列、机构、演员作品和清单详情的关联影片使用独立 `relatedVideoOffset`（每页60），滚动 replace URL，筛选或排序变化归零，非法参数规范化、总数缩小后回到有效页。导航到嵌套影片时保留该参数。该偏移不参与外层分类的 `facetOffset` 或清单主列表的 `playlistOffset`，避免混用列表位置。实现及验收见 [DG报告](performance/large-library-window-selection-results.md)。
