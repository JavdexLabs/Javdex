# Routing Design

本项目的路由目标是保留用户正在浏览的列表上下文，让详情、嵌套详情和返回行为都可预期。路由不是单纯表达资源 ID，也表达“从哪个列表面打开”。

## Core Model

- `ListSurface`: 可滚动、可筛选、需要保留状态的列表面，例如媒体库、演员、清单、分类。
- `DetailSurface`: 从列表面打开的详情面，例如影片详情、演员详情、分类详情、清单详情。
- `OverlayStack`: 在详情面内继续打开另一层详情，例如影片详情中打开演员，演员详情中打开影片。

`ListDetailShell` 是列表常驻模型的边界。列表面必须保持挂载，以保留滚动位置、筛选状态、虚拟列表测量和已加载数据。

## Route Semantics

当前路由使用嵌套路径表达上下文：

- `/`: 媒体库列表。
- `/detail/:id`: 从媒体库打开影片详情。
- `/actresses`: 演员列表。
- `/actresses/:id`: 从演员列表打开演员详情。
- `/actresses/:id/:videoId`: 从演员详情打开影片详情。
- `/playlists`: 清单列表。
- `/playlists/:playlistId`: 清单详情。
- `/playlists/:playlistId/:id`: 从清单详情打开影片详情。
- `/facet/:type`: 分类列表。
- `/facet/:type/v/:valueKey`: 某个分类值的影片列表。
- `/facet/:type/v/:valueKey/:id`: 从分类值列表打开影片详情。
- `.../actress/:actressId`: 从影片详情继续打开演员详情。

不要把所有影片详情强行规约到单一 `/videos/:id`。影片详情需要知道打开来源，才能返回原列表、保留筛选参数和维持用户的扫描位置。

## Query State

列表筛选、排序和搜索属于 URL query state。它们应该满足：

- 可复制：复制当前 URL 能恢复筛选条件。
- 可替换：输入搜索、筛选变化使用 `replace`，避免污染浏览历史。
- 可撤销：已应用筛选必须在页面上以 chip 呈现，并支持单项移除；搜索词由常驻搜索框呈现和清除，不重复显示为 chip。
- 可复用：列表导航 helpers 应传递当前 `location.search`，除非业务明确需要清空。

新增列表参数时，应先扩展 `listQueryParams.ts`，再由页面消费。不要在页面里手写分散的 query key 字符串。

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

清单列表搜索也属于 Shareable state；它虽然是本地过滤，但会改变用户看到的结果集，应使用 `q` query。

搜索词虽然使用 `q` query，但它属于 toolbar search state，不属于 `AppliedFilterBar` 的筛选 chip state。

## Navigation Helpers

业务代码不应直接拼复杂路径。优先使用 helper：

- `navigateToVideoDetail`: 从当前上下文打开影片详情。
- `navigateBackFromVideoDetail`: 关闭影片详情并回到原列表面。
- `navigateToActressFromVideoDetail`: 在影片详情中打开演员详情。
- `navigateToFacetDetail`: 打开分类值列表。
- `navigateToLibrary` / `navigateToActressList` / `navigateToFacetList` / `navigateToPlaylistList`: 回到一级列表。

新增路由时，按职责分层：

- route patterns: 供 `Route` 和 `useMatch` 使用。
- route builders: 生成 pathname。
- route parsers: 从 pathname 恢复上下文。
- navigation helpers: 表达用户意图，不暴露路径细节。

## Scroll And Refetch

列表面滚动位置需要绑定到稳定 key。key 应包含列表作用域和影响结果集的筛选 hash，例如 `library:${queryHash}` 或 `facet-detail:${queryHash}`。

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
- route match 常量维护在 `src/renderer/src/listView/routePaths.ts`（`ROUTE_MATCH`）。
- 打开详情时保留 `location.search`，除非明确进入另一类资源。
- 关闭详情时回到打开来源，而不是统一回到媒体库。
- 新增嵌套详情时同时补充 background scope、scroll/refetch 行为和返回按钮行为。
