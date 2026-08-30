# 多媒体库实施计划

本文件是 [多媒体库设计](MULTI_LIBRARY_DESIGN.md) 的执行与完成审计清单。只有所有必需项都有直接证据且质量门禁通过，功能才算完成。

## 基线

- 发布基线：v0.5.0 的 SQLite V13；0.6.0 未发布功能统一由一次 V13 → V14 迁移落地。
- 保留 V2–V13 的已发布历史升级链；不兼容或修复 0.6.0 开发期间出现过的 V14 中间 schema，开发库直接重建。
- 实施前基线：`npm run typecheck`、`npm run lint`、`npm run check:css-architecture` 通过。
- 完成时必须运行完整 `npm test`、`npm run build` 和本文列出的针对性测试。

## Requirement Matrix

| ID | 状态 | 要求 | 权威证据 |
|---|---|---|---|
| ML-001 | ✅ | 可创建、编辑、排序、归档多个媒体库 | `mediaLibraryRepo.test.ts`、`mediaLibraryHandlers.test.ts`、创建与设置 UI QA |
| ML-002 | ✅ | 每个媒体库拥有独立根目录和扫描/刮削/显示配置 | schema 约束、MediaLibrary Module/设置状态测试、独立设置 UI QA |
| ML-003 | ✅ | 同一全局影片可属于多个媒体库且不复制元数据 | V14 迁移、`libraryMembershipRepo.test.ts`、`homeDiscoveryRepo.test.ts` |
| ML-004 | ✅ | 影片资源和主资源严格按媒体库隔离 | V14 外键/索引、`videoLifecycleRepo.test.ts`、Scanner 隔离测试 |
| ML-005 | ✅ | 扫描、重定位、清理、审计、无法识别和待确认均按库隔离 | Scanner/Coordinator/Pending/ScanRepo/Cleanup/Audit 测试 |
| ML-006 | ✅ | `/` 是首页，展示跨库搜索、随机发现、近期添加和库状态 | Home 查询与路由测试、隔离 Electron QA |
| ML-007 | ✅ | 全局搜索跨库去重并可按库筛选 | `homeDiscoveryRepo.test.ts`、全局搜索状态/路由测试、隔离 Electron QA |
| ML-008 | ✅ | 每个媒体库有独立列表路由、query state、滚动与详情栈 | multi-library route、navigation memory、surface state 与 legacy redirect 测试 |
| ML-009 | ✅ | 旧单库数据无损迁入默认媒体库 | `migrationsV14.test.ts`、`legacyMediaLibraryBootstrap.test.ts` |
| ML-010 | ✅ | 删除、移出、移动和路径移除不会越库或默认删除磁盘文件 | Lifecycle、RootMigration、Cleanup、IPC path guard 与影响预览测试 |
| ML-011 | ✅ | 现有演员、分类、清单、刮削、Agent 和媒体资源功能不回归 | 1586/1586 app tests、5/5 packaging runtime、边界检查与构建 |
| ML-012 | ✅ | UI 遵循密集、安静、稳定和无障碍规范 | lint、CSS 架构、焦点/键盘测试与隔离 Electron QA |

## Phase 0：领域、决策与实施基线

- [x] 在 `CONTEXT.md` 定义全局目录、媒体库、媒体库成员和媒体库根目录。
- [x] 记录“全局资料 + 显式成员 + 库内资源”的 ADR。
- [x] 写入完整设计与实施计划。
- [x] 完整基线测试通过：1367 tests passed，无既有失败。
- [x] 创建 `codex/multi-library` 实施分支，保留工作树现有改动。

## Phase 1：共享类型与数据库迁移

- [x] 新增媒体库、配置、根目录、成员、扫描运行、无法识别和清理任务的共享类型。
- [x] 新增 `CatalogScope`、库摘要、首页快照和全局搜索结果类型。
- [x] 增加 SQLite schema 表、外键、检查约束和索引。
- [x] 重建 `video_resources`，增加库/根归属和库内主资源唯一约束。
- [x] 为本地和 STRM 资源回填规范化 `source_identity` 并建立库内唯一约束；跨库同时管理由启用根目录身份约束阻止。
- [x] 重建待确认扫描表，加入库作用域和稳定根目录引用。
- [x] 默认媒体库幂等 bootstrap 迁移旧路径、待清理路径、待确认根、配置、影片成员、资源和扫描状态。
- [x] 无法匹配旧根的资源标记为未托管，扫描不得自动清理。
- [x] 迁移前后验证影片/资源/待确认数量及外键完整性。
- [x] 测试空库、无资源影片、STRM、普通链接、离线路径和不完整旧设置。

## Phase 2：深 Module

- [x] 实现 `MediaLibraryCatalog`：列表、详情、创建和细粒度类型化变更命令。
- [x] 实现根目录规范化与跨库父子重叠验证。
- [x] 实现显式作用域的 `ScopedVideoCatalog`。
- [x] 所有列表投影一次返回库内资源统计和媒体库徽标，避免 N+1。
- [x] 实现 `HomeDiscovery` 最近添加、随机发现和全局搜索。
- [x] 实现 `VideoLifecycle` 的移出库、移动资源和全局删除预览/提交。
- [x] 为每个 Module 的 Interface 编写 SQLite `:memory:` 集成测试。

## Phase 3：扫描、调度与待确认隔离

- [x] `scanFolders` 的全部依赖和写入携带 `libraryId/rootId`。
- [x] 同番号候选可以复用全局影片，但必须创建当前库成员。
- [x] 资源重定位、缺失清理和主资源提升只查询当前库。
- [x] `ScanCoordinator` 冻结库配置/根目录快照并生成 `runId`。
- [x] 扫描开始、每个异步文件写入和清理前校验冻结的 realpath/device/inode，身份变化时禁止新增、更新、重定位、待确认写入和破坏性清理。
- [x] 自动扫描调度按库计算到期时间，仍串行使用维护锁。
- [x] 扫描事件、摘要、审计、无法识别快照按库发布和保存。
- [x] 局部扫描只替换本次已扫描且可访问根目录的无法识别快照。
- [x] 待确认组列表、解析、STRM 刷新和手动导入按库隔离。
- [x] 路径移除清理和主进程路径 guard 验证具体库/根归属。
- [x] 本地与 STRM 物理删除在暂存、重命名和最终删除前复用根状态与持久身份授权；无根归属或身份变化时失败关闭。
- [x] 增加跨库同番号、离线根、取消、失败、路径迁移和最后资源测试。

## Phase 4：IPC、Preload 与缓存作用域

- [x] 新增媒体库管理、首页、搜索和库设置 contract/channel/schema。
- [x] 影片列表、详情、年份、资源读写和删除 contract 使用显式 scope。
- [x] 扫描、待确认、审计和手动导入 contract 携带库 ID。
- [x] Preload 只暴露类型化调用，不传递数据库结构或原始配置 JSON。
- [x] React Query key 和失效 helpers 全部包含媒体库或全局 scope。
- [x] 对所有 IPC 参数执行 ID、revision、路径和枚举校验。

## Phase 5：路由、导航与独立媒体库页

- [x] `/` 切换为首页；新增 home/search/library route pattern、builder、parser 和 helper。
- [x] 首页/搜索详情使用可恢复的 `lib` query 保存活动媒体库，不依赖 `location.state`。
- [x] 旧 `/detail/:id` 兼容重定向到有效成员上下文。
- [x] 首页、搜索、每库列表分别使用稳定 `ListDetailShell`。
- [x] `LibraryPage` 接收路由库 ID，查询、年份、统计、批处理和滚动 key 全部作用域化。
- [x] 影片详情只展示/操作当前库资源，并显示其它库成员摘要。
- [x] 动态侧栏展示首页和媒体库组，支持排序、状态与新建入口。
- [x] 一级导航记忆、reload reset、background scope 和返回行为适配新路由。
- [x] 演员、分类、清单和待确认中的影片详情继续保留原列表上下文。

## Phase 6：首页、搜索和媒体库设置 UI

- [x] 首页常驻搜索，支持快捷键、建议键盘导航和提交。
- [x] 随机发现批次稳定，“换一批”才改变种子。
- [x] 近期添加按成员时间去重，卡片显示媒体库徽标。
- [x] 媒体库状态区展示数量、根目录状态、扫描和待确认信息。
- [x] 全局搜索页写入 URL query，支持媒体库多选过滤和去重详情。
- [x] 新建媒体库流程支持基本信息、目录、配置和可选首次扫描。
- [x] 媒体库设置包含常规、来源、扫描、刮削、显示和危险操作。
- [x] 路径重叠、离线、空库、无结果、扫描中和错误状态都有稳定 UI。
- [x] 新样式使用同名 CSS Module 和语义 token；无全局 CSS 基线增长。
- [x] 键盘焦点、可访问名称、最小点击目标和稳定滚动槽通过检查。

## Phase 7：兼容、性能与完成审计

- [x] 旧设置字段只在迁移读取，运行时无双重事实源。
- [x] 旧 `videos.add_time` 只表达全局记录时间；库内排序全部使用成员时间。
- [x] 首页和全局搜索无 `ORDER BY RANDOM()`、无卡片级 N+1。
- [x] 数据库查询计划使用预期索引；大数据 fixture 验证分页和首页延迟。
- [x] 运行针对性迁移、Module、扫描、路由和 UI 测试。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`、全部边界检查和 `npm run check:css-architecture`。
- [x] 运行完整 `npm test`。
- [x] 运行 `npm run build`。
- [x] 依据本文件逐项检查 ML-001 至 ML-012 的直接证据。
- [x] 使用 `code-review` 同时执行 Standards 与 Spec 审查。
- [x] 修复所有审查发现并重跑受影响门禁。
- [x] 检查 `git diff --check`、提交范围和现有 Agent 改动兼容性。
- [x] 创建清晰的功能提交；不推送，除非用户另行要求。

## 必测边界场景

1. A、B 两库同时包含同一全局影片，各有不同主资源；切换库时播放和资源操作不串库。
2. A、B 两库存在相同番号但不同身份待定影片；扫描不能越库重定位或静默选择错误目标。
3. A 根目录离线或扫描失败时，B 的任何数据不变化，A 也不执行不安全清理。
4. 从 A 移除最后资源不会删除 B 的资源或全局资料；固定的 A 成员仍可保留。
5. 永久删除 A 默认不删除源文件，并准确预览仍被 B 使用的全局影片。
6. 待确认组、无法识别快照、扫描摘要和自动扫描到期时间分别属于各库。
7. 全局搜索和首页对同一影片去重，库内列表各显示一次；近期添加使用各自成员时间。
8. 根目录相同、大小写等价或父子嵌套时拒绝创建冲突配置。
9. 从旧数据库升级后全部现有影片仍出现在默认媒体库，资源和扫描状态无损。
10. 首页、搜索、每库列表打开详情并返回后，原 query、滚动位置和已加载列表保持。
11. 局部扫描不抹掉同库其它根的无法识别项，也不消费要求完整扫描的路径清理任务。
12. 根目录 realpath/device/inode 在扫描期间变化时，扫描报告不可用且不执行缺失清理。
13. `settings.json` bootstrap 在数据库已提交、JSON 清理失败后重复运行不会重复创建库、根或成员。
14. 持有资源、待确认项或无法识别项的根目录被同路径替换后，重新启用和归档恢复都拒绝自动重绑。
15. 待移除根目录因离线或身份变化不能清理时，可以取消到停用；影片资源、待确认项、无法识别项和冻结身份均保持不变。
16. 清理确认后修改无关媒体库配置，任务仍按已确认身份安全完成，配置 revision 只保留为审计快照。
17. 最近扫描没有 summary、但迁移或旧数据恢复留下无法识别快照时，独立媒体库扫描页仍展示可操作项。
18. 应用设置总览展示真实活跃媒体库和来源目录聚合，并跳转明确库设置，不读取固定默认库配置。
19. 停用、待移除或同路径替换后的根中删除本地/STRM 资源时，不得暂存、重命名或删除当前路径文件，资源记录保持不变。
20. 扫描、手动导入或重命名导入在异步探测期间发生同路径换盘时，最终写入必须拒绝，不能混合旧文件指纹和新目录路径，也不能留下待确认或审计污染。
21. legacy cleanup 根与任一 active/pending 根形成父子路径或 realpath/device-inode 别名冲突时，完整扫描恢复仍保持 `disabled/failed`，且不修改 revision。
22. 已有资源、待确认项或无法识别项但持久身份不完整的根，扫描前绑定、重新启用和归档恢复都必须拒绝；只有空根允许首次冻结身份。
23. 首页随机发现保留普通外部链接，只接受同库 active 根下的本地/STRM 资源；停用、待移除、归档或跨库错误根不能使影片进入推荐。

## 完成记录

状态：已完成。功能实现、自动化门禁、隔离 Electron QA、双轴复审和功能提交均已通过。

- 实施范围：v0.5.0 发布基线至本提交；数据库由 V13 一次升级到 V14。
- 自动化测试：`npm test` 通过，其中应用测试 1586/1586、packaging runtime 5/5；迁移、Module、扫描、清理、路由、设置与扫描审计测试均包含在内。
- 构建与静态门禁：`npm run build`、`npm run typecheck`、`npm run lint`、四项边界检查、`npm run check:css-architecture`、`npm run check:encoding` 和 `git diff --check` 均通过。
- 性能证据：Scoped Catalog、首页和全局搜索的大数据 fixture 使用 `EXPLAIN QUERY PLAN` 验证预期索引，并验证有界分页、去重和无卡片级 N+1。
- 隔离 Electron QA：通过主页随机发现、近期添加和媒体库卡片；跨库搜索及媒体库筛选；四步创建“NAS 收藏”；独立媒体库列表；独立媒体库设置常规、来源和扫描；应用设置总览真实 2 库聚合及深链；扫描审计空态。
- 根目录恢复 QA：构造 `pending_removal` 来源后确认“取消移除（保持停用）”按钮可用；操作后根状态由 `pending_removal` 变为 `disabled`、清理任务由 `pending` 变为 `cancelled`，按钮区稳定恢复。
- 完整性回检：四条独立红测复现并修复替换目录误删、异步扫描/导入换盘写入、legacy 冲突根错误恢复和 identity-null owned root 自动绑定；联合高风险回归 201/201 通过。
- 首轮双轴复审修复：随机发现排除非 active/跨库受管根；路由契约与 helper 同步；媒体库颜色改为共享视觉身份变量；设置页拆分为页面协调层、六个 tab 组件和确认弹窗组件。第二轮隔离 Electron QA 已回检首页、蓝色媒体库标识和全部设置 tab。
- 最终复审与提交：首轮 Standards/Spec 发现已全部修复并重跑完整门禁；第二轮同时复审为 Standards clean、Spec clean，无 Blocker/High/Medium 或值得继续修改的 smell。本记录随本提交交付，按用户要求未推送远程。
