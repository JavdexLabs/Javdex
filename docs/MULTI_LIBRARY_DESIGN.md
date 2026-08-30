# 多媒体库设计

状态：已实施
决策依据：[ADR-0023](adr/0023-share-catalog-metadata-across-media-libraries.md)、[ADR-0024](adr/0024-preserve-media-library-root-identity-continuity.md)

## 目标

Javdex 支持多个命名媒体库。每个媒体库拥有独立配置、扫描目录、影片成员、影片资源、扫描结果和待确认项；影片、演员、导演、系列、机构、标签与清单继续由全局目录共享。

应用新增首页，提供跨媒体库搜索、随机推荐、近期添加和媒体库状态；原单一媒体库列表拆为 `/libraries/:libraryId` 下的独立列表面，并继续保留列表筛选、滚动和详情返回上下文。

## 非目标

- 首期不复制演员、分类实体、标签或清单到各媒体库。
- 首期不提供每库影片标题、封面、评分或标签覆盖；刮削结果仍写入全局影片。
- 随机推荐是本地随机发现，不是个性化模型推荐。
- 首期不并行运行多个扫描或资源维护任务。
- 不允许两个启用的媒体库扫描相同或互相嵌套的根目录。

## 领域结构

```text
全局目录
  ├─ 影片 ── 演员 / 机构 / 导演 / 系列 / 标签 / 清单
  └─ 影片业务身份（全局唯一）

媒体库
  ├─ 独立配置
  ├─ 媒体库根目录
  ├─ 媒体库成员 ──> 全局影片
  │    └─ 库内影片资源（含一个可选主资源）
  ├─ 扫描运行与审计
  └─ 待确认扫描组 / 无法识别项
```

## 强制不变量

1. 同一影片可属于多个媒体库，但全局元数据只有一份。
2. 每条影片资源恰好属于一个媒体库，并且必须存在同库影片成员。
3. 每个媒体库成员至多有一个主影片资源。
4. 本地文件和 STRM 源文件在任一时刻只能由一个启用根目录管理；停用或归档库可保留历史资源记录，重新启用时必须重新通过根目录冲突校验。
5. 启用的媒体库根目录不得相同，也不得互为父子路径。
6. 单库读取必须使用显式 `libraryId`；全局读取必须使用显式 `all` 作用域。省略作用域不是合法调用。
7. 扫描、重定位、缺失清理、路径移除和待确认处理不得修改其它媒体库的成员或资源。
8. 媒体库扫描只使用运行开始时冻结的配置与根目录快照。
9. 移出媒体库与全局删除影片是两个不同命令；前者永远不隐式删除全局影片或其它库资源。
10. 归档媒体库是默认删除方式；永久删除默认不删除磁盘文件。
11. 根目录持有影片资源、待确认资源或无法识别项后，重新启用、恢复归档和安全清理都必须保持已确认的物理身份；相同路径上的替换目录不能自动继承这些记录。
12. 取消待执行的路径移除只撤销清理意图并将根目录转为停用；它不删除归属记录、不恢复扫描，也不采纳替换目录。

## 数据模型

### `media_libraries`

| 字段 | 说明 |
|---|---|
| `id` | 稳定整数 ID |
| `name` | 非空显示名称 |
| `icon` | 受支持图标标识 |
| `color` | 可选强调色标识，不保存任意 CSS |
| `position` | 侧栏排序 |
| `status` | `active` / `archived` |
| `revision` | 乐观并发版本 |
| `created_at` / `updated_at` | 生命周期时间 |

### `media_library_configs`

稳定、需要验证或影响调度的配置使用类型化列，不存未验证 JSON：

- `auto_scan_enabled`
- `auto_scan_interval_minutes`
- `min_import_duration_minutes`
- `auto_merge_same_code_resources`
- `remove_resource_less_memberships`
- `default_video_scraper`
- `default_sort`
- `include_in_home_discovery`
- `revision`

主题、隐私模式、媒体资源存储、加密、插件连接、代理、凭据和模型配置继续是应用级设置。

### `media_library_roots`

保存 `library_id`、原始路径、规范化路径、最近确认的 realpath、device/inode 身份、位置和 `active` / `pending_removal` / `disabled` / `archived` 状态。精确规范化路径和 realpath 身份建立全局唯一约束；父子路径及符号链接别名冲突由媒体库 Module 在同一事务前校验。

空根目录首次在线时可以原子冻结物理身份；一旦根目录持有影片资源、待确认资源或无法识别项，普通路径编辑、从停用重新启用及媒体库恢复都不得把这些记录重绑到不同物理目录。已有归属但历史身份不完整的根同样失败关闭，不能让后来占用相同路径的目录继承数据。扫描开始、每个异步文件处理后的最终写入、缺失清理和路径移除清理前都再次核对冻结身份；离线或身份变化时保留全部记录。旧版 cleanup-only 等待任务使用独立恢复路径，只清理数据库归属并仍须通过全局根重叠校验。

### `library_video_memberships`

组合主键为 `(library_id, video_id)`，并保存：

- `added_at`：单库列表“添加时间”和首页“近期添加”的权威来源。
- `updated_at`
- `added_via`：`scan` / `manual` / `shared`
- `is_pinned`
- `is_hidden`
- `discovery_key`：稳定随机发现键。

现有 `videos.add_time` 保留为全局影片记录创建时间，不再表示加入某个媒体库的时间。

### `video_resources`

增加 `library_id`、可空 `root_id` 和可空 `source_identity`；`(library_id, video_id)` 组合外键指向媒体库成员。主资源唯一索引改为对 `(library_id, video_id)` 的部分唯一索引。

- 本地资源和 STRM 源文件的 `source_identity` 使用规范化源路径，并在 `(library_id, source_identity)` 内唯一；普通链接保持为空。跨库同时管理同一路径由启用根目录的全局重叠/身份约束阻止，停用或归档库则可保留历史资源记录。根目录禁止符号链接别名，资源身份按经过根身份校验后的规范化源路径保存。
- 普通链接资源按 `(library_id, resource_key)` 去重，允许同一目标分别存在于不同媒体库。
- `root_id` 只用于受媒体库根目录管理的本地资源和 STRM 资源。

### 扫描状态

- `pending_scan_groups` 增加 `library_id`，唯一键为 `(library_id, normalized_code)`。
- `pending_scan_resources` 以 `root_id` 代替可漂移的 `scan_root` 文本。
- `library_scan_runs` 保存 `library_id`、`config_revision`、触发来源、状态、开始/结束时间、摘要和有界审计。
- `library_unrecognized_files` 按库和根目录保存最近一次安全扫描的快照；成功的局部扫描只替换本次已扫描且可访问根目录的快照，未选择或离线根目录继续保留。
- `library_root_cleanup_jobs` 保存被移除根目录的延迟安全清理，不再放入应用设置 JSON。任务状态为 `pending` / `running` / `completed` / `failed` / `cancelled`；`config_revision` 只记录确认时配置快照，不让之后无关的配置修改阻塞已确认清理。取消任务后根目录转为 `disabled` 并保留身份及归属记录；直接删除空根目录时可以一并删除其终态清理历史，但确认界面必须披露数量。

## 深 Module 与 Interface

### `MediaLibraryCatalog`

负责媒体库生命周期、配置、根目录约束和摘要投影：

```ts
interface MediaLibraryCatalog {
  list(): MediaLibrarySummary[]
  get(libraryId: number): MediaLibraryDetail | null
  create(input: CreateMediaLibraryInput): MediaLibraryDetail
  update(input: UpdateMediaLibraryInput): MediaLibraryDetail
  updateConfig(input: UpdateMediaLibraryConfigInput): MediaLibraryConfig
  addRoot(input: AddMediaLibraryRootInput): MediaLibraryRoot
  updateRoot(input: UpdateMediaLibraryRootInput): MediaLibraryRoot
  removeRoot(input: RemoveMediaLibraryRootInput): MediaLibraryRoot
  cancelRootRemoval(input: CancelMediaLibraryRootRemovalInput): MediaLibraryRoot
  migrateRoot(input: MigrateMediaLibraryRootInput): MediaLibraryRootMigrationResult
  archive(input: MediaLibraryRevisionInput): MediaLibraryDetail
  restore(input: MediaLibraryRevisionInput): MediaLibraryDetail
  previewRemoval(libraryId: number): MediaLibraryDeletePreview
  remove(input: DeleteMediaLibraryInput): MediaLibraryDetail
}
```

调用方使用细粒度类型化命令；Module 隐藏重命名、重排、配置更新、根目录添加/移除/迁移、取消待移除、归档和永久删除的事务差异，并返回稳定领域错误：`LIBRARY_NOT_FOUND`、`REVISION_CONFLICT`、`ROOT_OVERLAP`、`LIBRARY_BUSY`、`DELETE_REQUIRES_CONFIRMATION`。

### `ScopedVideoCatalog`

```ts
type CatalogScope =
  | { kind: 'library'; libraryId: number }
  | { kind: 'all'; libraryIds?: number[] }

interface ScopedVideoCatalog {
  list(scope: CatalogScope, query: VideoQuery): VideoListResult
  get(scope: CatalogScope, videoId: number): ScopedVideoDetail | null
  years(scope: CatalogScope): number[]
}
```

实现内部统一处理成员 JOIN、库内资源投影、全局去重、媒体库徽标、分页和排序；渲染端、IPC handler 和其它业务模块不得复制这些 JOIN。

首页和搜索详情同样需要一个可恢复的活动媒体库。它使用 URL 的 `lib` query 参数保存，不依赖 reload 后会丢失的 `location.state`；库内详情直接从路径中的 `libraryId` 得到作用域。

### `HomeDiscovery`

```ts
interface HomeDiscovery {
  load(input: HomeDiscoveryInput): HomeSnapshot
  search(input: GlobalSearchInput): GlobalSearchResult
}
```

首页最近添加按成员 `added_at` 排序并按影片去重。随机发现按持久 `discovery_key` 从随机游标做两段索引范围查询，禁止 `ORDER BY RANDOM()`。普通重新获取保持种子稳定，“换一批”才更换种子。

### `LibraryScan`

```ts
interface LibraryScan {
  run(request: { libraryId: number; rootIds?: number[]; trigger: LibraryScanTrigger }): Promise<ScanResult>
  cancel(runId: string): boolean
  subscribe(listener: (event: LibraryScanEvent) => void): () => void
}
```

运行开始时读取并冻结库配置、根目录和 revision。扫描文件发现可以异步，数据库写入和最终清理继续串行并受全局维护锁保护。

### `VideoLifecycle`

将以下命令显式区分：

- `removeFromLibrary(libraryId, videoId, options)`
- `moveResource(sourceLibraryId, targetLibraryId, resourceId)`
- `deleteGlobally(videoId, options)`

所有命令先返回影响预览，再以 revision/idempotency 信息提交。磁盘删除继续复用可恢复暂存流程。

## 扫描与归并

1. 以 `libraryId` 获取配置和包含 realpath/device/inode 的完整根目录快照，并确认当前身份。
2. 只读取当前库根目录及当前库的待确认资源。
3. 已绑定源文件只更新同库资源；任何异步读取或探测完成后，必须在资源更新、新增、重定位、待确认写入和 STRM 同步前重新验证文件仍属于冻结根身份。
4. 新文件按规范化番号查找全局影片候选：
   - 唯一候选且自动归并开启：建立当前库成员并导入资源。
   - 多个候选或自动归并关闭：进入当前库待确认组。
   - 无候选：创建身份待定影片、成员和资源。
5. 重定位候选只从当前媒体库资源中选择。
6. 只有当前库可访问且结束时身份未变化的根目录中的缺失资源可以清理。
7. 清理最后一个库内资源时，只按当前库配置移除无资源成员；不得自动删除全局影片。
8. 成功或完成但有隔离失败项时，只替换当前库扫描摘要和审计；无法识别快照只替换本次安全扫描过的可访问根目录。

## 首页和搜索交互

首页使用安静、紧凑的 `list-page`：

1. 顶部常驻跨库搜索框，支持 `Cmd/Ctrl+K` 聚焦；输入后在首页以 `?q=` 即时展示去重结果。
2. “随机发现”展示有可访问资源的去重影片，带媒体库徽标和“换一批”。
3. “近期添加”按最新成员加入时间显示去重影片。
4. “媒体库”区块展示数量、根目录在线状态、最近扫描和待确认数量。

随机发现的 SQL 资格将无根目录的普通外部链接视为可访问，并只接受归属同库 `active` 根目录的本地或 STRM 受管资源；首页查询不逐影片探测磁盘。启用根目录瞬时离线或源文件缺失由扫描生命周期和详情可用性处理，不在卡片查询中制造文件系统 N+1。

全局搜索以首页即时结果为主；`/search?q=` 仍可作为带媒体库多选过滤的结果页。首期匹配番号、标题、演员主名和已确认别名，与现有影片列表搜索语义一致。搜索实现放在独立 Module 后，可在数据量证明确有需要时替换为 FTS5，而不改变调用方。

## 路由与导航

```text
/                                      首页；存在 q 时切换为搜索结果
/home/video/:videoId?lib=:libraryId    从首页打开影片详情
/search?q=...                          带媒体库筛选的全局搜索
/search/video/:videoId?q=...&lib=:libraryId
/libraries/:libraryId                  独立媒体库列表
/libraries/:libraryId/video/:videoId   从该库打开影片详情
/libraries/:libraryId/video/:videoId/actress/:actressId
/settings/library/:tab?library=:libraryId  全局设置工作区中的媒体库设置
/libraries/:libraryId/settings/:tab    旧入口，重定向到全局设置工作区
```

首页、搜索和每个媒体库各自是 `ListSurface`，各自由 `ListDetailShell` 保持列表挂载。媒体库列表滚动键必须包含 `libraryId` 和 query hash。首页和搜索卡片打开详情时必须写入活动媒体库 `lib`；影片属于多个库时优先使用本次卡片来源，其次使用最近访问的有效媒体库。缺失或失效的 `lib` 由主进程返回成员摘要，渲染端选择确定值后 `replace` 到规范 URL。旧 `/detail/:id` 作为兼容入口，解析可用成员后替换到新的上下文详情。

侧栏增加“首页”和动态“媒体库”分组；清单、演员、分类、待确认与应用设置保持全局。待确认中心的扫描项显示媒体库徽标并支持库筛选。

## 媒体库设置

- 常规：名称、图标、排序和归档状态。
- 来源与扫描：根目录、在线状态、添加、移除、取消待移除和迁移；最小时长、自动归并、无资源成员清理、自动扫描、周期、最近摘要和扫描审计。当前无法识别快照独立于最近摘要展示；旧数据恢复或迁移只有快照而没有摘要时，仍提供按根目录处理入口。
- 刮削：默认影片刮削器；代理和凭据仍为全局。
- 显示：首页发现开关和默认排序；封面比例统一使用应用级外观设置。
- 维护：归档和永久删除。

影片批量刮削保留一个受控的旧入口：媒体库页面和扫描后的维护动作必须传
`libraryId`，主进程只解析该活动媒体库中的可见成员，显式 `videoIds` 也不能越过
此边界；应用级设置页省略 `libraryId` 时沿用全局影片目录语义，界面必须明确标为
“全局目录”。检查点保存原始作用域，恢复和逐项执行前都会重新验证成员关系。

应用级设置不编辑某个隐含默认媒体库。总览只读取活跃媒体库及其来源目录的真实聚合数量，并跳转到明确的独立媒体库设置；所有根目录和扫描配置都在 `/settings/library/:tab?library=:libraryId` 中维护。离开媒体库设置后再进入时，应恢复上次查看的媒体库，而不是静默改写为默认库。

创建媒体库使用分步流程：基本信息 → 根目录 → 扫描配置 → 可选首次扫描。空媒体库允许创建。

## 生命周期与危险操作

- 移除根目录先展示影响预览；默认只移除数据库管理关系，不删除磁盘文件。
- 待移除根目录可以取消；取消后保持停用并保留物理身份、影片资源、待确认项和无法识别项。
- 删除本地或 STRM 影片资源前必须由共享主进程授权边界重新查询其 `libraryId/rootId`，要求根处于启用状态、持久身份完整且当前身份一致；暂存、重命名和最终删除前均重新验证，不能仅凭保存的文件路径执行物理操作。
- 移出媒体库只删除当前库成员及当前库资源。
- 永久删除媒体库必须展示资源、成员、待确认项和独占影片数量；默认不删磁盘文件。
- 全局删除影片必须展示所有媒体库资源、清单关系和媒体资源影响，并删除本地视频与 STRM 源文件。
- 同一根目录迁移到另一媒体库使用原子命令，不通过“移除后重新扫描”模拟。

## 安全与性能

- Renderer 传入的 `libraryId`、`rootId` 和路径均视为不可信；主进程重新查询所属关系并进行路径校验。
- 共享的主进程根文件授权 Module 按 `libraryId/rootId` 校验根状态、持久身份、冻结快照、当前物理身份和文件包含关系；IPC、扫描、手动导入、重命名和物理删除复用同一边界，禁止只验证“属于任意库”或只验证文本路径。
- 扫描事件必须携带 `runId/libraryId`，防止多个设置页或未来队列串线。
- 主要索引：成员 `(library_id, added_at DESC, video_id)`、成员 `(video_id, library_id)`、资源 `(library_id, video_id, is_primary)`、全局近期成员 `(added_at DESC, video_id)`、待确认 `(library_id, updated_at)`。
- 全局搜索和首页聚合返回去重影片及有界媒体库摘要，不在每张卡片执行独立查询。

## 迁移

1. 创建唯一“默认媒体库”和默认配置。
2. 通过幂等 bootstrap 将旧 `settings.json` 中路径和扫描配置迁入默认库；数据库先提交迁移标记和来源摘要，再尽力清理旧 JSON 字段，运行时只读 SQLite，避免双重事实源。
3. 为全部影片创建默认库成员，`added_at` 回填 `videos.add_time`。
4. 为全部资源回填默认库；本地和 STRM 根据旧路径关联根目录，普通链接 `root_id = NULL`。
5. 将待确认组、无法识别快照、路径清理任务和最近扫描审计归入默认库；路径集合取现有路径、待清理路径和待确认资源 `scan_root` 的并集。具备可信身份且不冲突的待清理路径建为 `pending_removal` 根；离线、身份不完整、父子重叠或物理别名冲突的路径保留为 `disabled`，对应清理任务以可恢复 waiting/failed 状态等待原身份恢复。
6. V14 一次性重建资源及多媒体库表和最终唯一索引，启用组合外键，并将待确认资源的规范化路径唯一性收窄到媒体库作用域。
7. 切换所有读取和写入到显式 scope 后，再删除旧设置字段。
8. 迁移完成后验证影片、资源、待确认资源数量不变，并验证每条资源恰有一个有效成员。

无法与旧根目录匹配的本地或 STRM 资源仍归属默认媒体库，但 `root_id = NULL` 并标记为未托管，扫描不得自动清理。迁移必须幂等；SQLite 升级失败保留原数据库，跨存储 bootstrap 失败可安全重试，不进行重复导入。

## 完成标准

完整完成标准及证据记录在 [多媒体库实施计划](MULTI_LIBRARY_IMPLEMENTATION_PLAN.md)。
