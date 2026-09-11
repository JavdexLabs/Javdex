# 大库优化实施与验收记录

2026-09-10，分支 `codex/large-library-performance`，基线 `4c953a9`。对应[完整计划](large-library-optimization-plan.md)。用户已授权执行并验收；本记录替代计划中“尚未开始实施”的历史状态说明。尚未提交、推送或发布。

## 最新状态：DG 分页窗口、大选集和浏览入口通过本地验收

用户继续授权第4项。本轮统一主列表/搜索/演员的三页窗口与卡片载荷准入、独立ID选择和受控批量预览，补齐清单及分类详情关联影片的分页入口。全量2890通过/1跳过/0失败，构建成功，4组浏览器100页/20筛选场景通过。实现、验收与尚存的配置/显式维护边界见[DG报告](large-library-window-selection-results.md)。工作区仍未提交、推送或发布。

## 历史状态：DF 高频读取与清理优化完成本地验收

用户随后授权执行优先级第1、2、3项。本轮新增连接修订缓存、高频桌面/Web只读worker入口、可取消的分批清理和退出drain；全量2850通过/1跳过/0失败；具体范围、语义调整、本机数据与剩余边界见[DF报告](large-library-high-frequency-cleanup-results.md)及[证据清单](large-library-results/implementation/batch-df-manifest.json)。

## 历史状态：DD/DE 收尾完成，按当时要求停止

2026-09-11，用户将执行范围收敛为“NFO相关优化完成后，完整更新计划并停止”。本轮已完成预检计数及NFO目录/预检/队列的代码优化与本地验收：245项联合回归通过，全量2813通过/1跳过/0失败，构建成功。代码、日志与复核证据见文末DD/DE及 `large-library-results/implementation/batch-de-manifest.json`。工作区未提交、推送或发布。

默认扫描使用schema18逐项审计、摘要结果及TEMP文件清单；自动合并模式跳过无用计数，其他模式使用精确TEMP计数；NFO工作集改为按需读取和按作品应用，入队与资源/基础审计同事务。保留单作品anchors/候选、瞬时目录Map、同步目录写入及非持久队列边界，不能据此宣称整个NFO阶段固定内存、250ms或崩溃恢复保证。

**本轮到此停止，不继续其他工作包。** 完整15工作包/42风险仍未全部验收；剩余工作与目标环境测量见[完整待办矩阵](large-library-optimization-plan.md#12-收尾范围与完整待办矩阵)。以下批次为历史记录，其中“继续/下一步/尚未切换”等叙述不覆盖当前停止决定。

## 首批 B：历史记录

已实现待最终审查：

- PERF-01A：扫描根路径/清理审计汇总不再使用大数组实参；取消在枚举收尾被识别。实际扫描入口以300,382/600,764合成路径回归，停止时零导入。并用Set替换待确认审计的反复路径扫描（01B局部）。清理协调器另以300,382项校验removed/promoted/deleted三份审计的完整顺序。全量路径内存仍待08A处理。
- PERF-02A：专用count从DB、服务、控制器、IPC、preload贯通侧栏；详情仍使用原list；计数独立query key，收件箱刷新包含计数。1万条含不可解析详情的记录仍可直接计数，并断言只准备一条COUNT SQL；删除/级联删除后数字正确。徽标新增加载/失败状态；轮询尚保留，事件化与02B仍需验证。
- PERF-03局部：活动单库不走排名，count和页面同事务；无筛选单库count只查可见成员；当前ID/成员页先物化，再补宽投影。首页recent使用no-count API；单库随机推荐不排名。多库随机推荐仍待改造，count缓存尚未实施。
- PERF-04局部：标签/演员先对可见影片去重并聚合；保留无关联标签和手工隐藏关系的零计数。AA另修复缺统计时手工标签外连接退化，增加同库统计探针；生产统计维护、概要缓存及窄名称候选尚未实施。

## 性能证据

[本批原始结果](large-library-results/implementation/batch-b-300382.json)、[源代码快照](large-library-results/implementation/batch-b.patch)、[证据清单](large-library-results/implementation/batch-b-manifest.json)。JSON内baselineCommit只是基线，生产代码差异以patch为准。Mac M4，300,382合成影片，已ANALYZE，3次热中位数；不是p95或Windows/HDD验收。

| 场景 | 审计基线 ms | 本批 ms |
|---|---:|---:|
| 显式单库目录 | 1,640.44 | 72.25 |
| 全库仅一个活动库 | 2,080.97 | 69.71 |
| 发行日期排序 | 1,629.10 | 84.19 |
| scoped番号子串 | 982.98 | 377.39 |
| 全部标签 | 1,182.67 | 574.06 |
| 手工标签 | 1,443.25 | 681.39 |
| 演员首屏 | 523.69 | 438.81 |
| 首页单库 | 1,658.04 | 77.93 |
| 重叠双库目录 | 1,730.52 | 506.62 |
| 重叠双库首页 | 2,459.74 | 1,028.40 |

不把所有差异归因于代码：跨进程、系统缓存和CPU争用不同；演员小幅收益尤其需多次独占环境复核。清单全量返回、图片读取、Web查询与长期任务风险仍存在。没有降低原计划验收门槛。

## 验证状态

- 首轮定向117项通过，包含新增汇总、计数和筛选测试。
- 第一轮完整 `npm test`：1,958通过、1跳过、0失败；包括pretest架构/lint和类型检查。之后手工标签SQL及收件箱刷新发生小改动，需最终复跑。
- 最新集成 `npm test`：1,961通过、1跳过、0失败（1,962项），包含本轮修正和扫描/NFO改动；`npm run build` 也已重新完成。没有启动真实用户库。
- Standards审查：0明确违规，1项共享可见性SQL的P3建议。Spec审查：3项P2验收缺口（徽标未知态、count详情读取断言、清理大规模汇总）已补实现/测试；修正后集成测试通过；规格复核确认三项已修复，另指出最后一个NFO批次取消漏标，现已修复并用单批/两批场景回归。
- 最后一个NFO批次取消修复后，scanner/coordinator定向88项通过；此一行状态修正晚于上面的全量测试与构建，下一批集成再次覆盖。
- 未做：Windows SSD/HDD、冷盘、多设备、8小时长跑、升级/断电/磁盘满等完整矩阵。

## 工作包状态与下一步

| 包 | 状态 | 仍需完成 |
|---|---|---|
| 00 | 部分完成 | 端到端/主循环/FS/恢复与目标硬件矩阵 |
| 01 | 部分完成 | 大规模汇总、扫描/批量UI进度合并和STRM候选索引已落地；极端重复/混合写入与目标环境端到端验收仍待完成 |
| 02 | 部分完成 | PendingCenter刮削和扫描/身份队列概要分页和按需详情已落地；审计三类待办状态已按页合并查ID；演员概要分页/选中详情已接入；原始审计后端分页、按变更更新及目标硬件验收仍待完成 |
| 03 | 部分完成 | 多库候选减量、计数复用、更多过滤/排序差分 |
| 04 | 部分完成 | 已选标签窄查询、手工/筛选候选分页与V17覆盖索引已完成；统计维护、概要缓存、热门筛选页关联成本及其他窄筛选性能仍待验证 |
| 05 | 部分完成 | 清单、手工标签、TagFilter、演员身份及合并候选有界分页已验证；演员/分类详情、其余候选、视口虚拟化和整体视觉仍待完成 |
| 06 | 部分完成 | 清单旧请求保护已落地；通用缓存/选择/失效和批量并发仍待完成 |
| 07 | 部分完成 | 桌面/Web图片异步读取/解密、有界排队、字节缓存及同图在途合并已落地；单图编码字节/画布像素上限已实现；首批卡片缩略图已接入；总字节预算、其他图片入口与头像状态仍待完成 |
| 08 | 部分完成 | 预处理循环跳过路径也让步/响应取消，NFO尾部不再启动新任务并保留已提交审计；Agent恢复已按产品筛选并逐条加载；全量数据流式化/其余启动与生命周期仍待实施 |
| 09 | 部分完成 | checkpoint固定清单与进度分离、加密别名增量日志已实现；大规模/目标硬件恢复验收、文件与DB交割、日志字节预算、插件日志已改追加存储，元数据活动日志、历史内存/分页与剩余恢复矩阵仍待完成；Agent游标已改索引查询 |
| 10 | 部分完成 | 标签筛选IPC已接入单只读worker、有界合并队列与修订缓存；本机原生/ASAR验证通过；其余读路径、原生长查询终止、IPC取消及全平台验收仍待完成 |
| 11–12 | 待实施 | 搜索路径、条件FTS、深页与排序 |
| 13–14 | 待实施 | 迁移/附件/历史/LAN预算和参数实验 |

继续顺序：收敛本批审查与全量回归 → 剩余03/04与08A的扫描让步/取消 → 02B/05分页 → 其余计划。所有42项风险的最终处置仍以计划第九、十节验收；当前远未达到完整目标，保持目标进行中。


## 后续批次 C：多库随机推荐

- 改为每库按 discovery 索引取前N个规范候选，再按全局键合并；以更小随机键/同键更小库ID排除非首选成员。资源可用性规则复用相同条件；不会将游标之后的重复成员冒充原本在游标之前的影片。
- 每个compound SELECT最多64个媒体库，分块结果再合并；不受SQLite compound数量上限限制。返回候选数量有界，但高重叠时排除非首选成员仍可能扫描许多行，尚未把最坏计算量变为固定页成本。
- 对照原ROW_NUMBER算法做80组组合验证（单库、双库、70库 ×20种seed），覆盖同键、隐藏成员、无资源成员和游标回绕；现有根目录状态/跨库资源隔离测试仍保留。
- [30万合成结果](large-library-results/implementation/batch-c-discovery-300382.json)：单库首页75.53ms、重叠双库703.59ms热中位数，上一批分别77.93ms/1,028.40ms。仍非p95、Windows或高重叠最坏情况验收；PERF03继续保持部分完成。
- 本批只改变homeDiscoveryRepo查询及其测试。源基线仍是未提交工作区；本批查询差异见[快照](large-library-results/implementation/batch-c-discovery.patch)及[复现说明](large-library-results/implementation/batch-c-manifest.json)。节点类型检查和14项homeDiscovery测试通过。


## 后续批次 D：大清单分页

- 增加类型化 `playlist:getPage`，在事务中返回元数据、全量/筛选计数和有界影片页。过滤和排序先于页面投影，当前默认60条、服务端最大200条；旧get保留给兼容调用，桌面清单页已切到新接口。
- 页码前后切换、资源筛选/排序后回首屏、删除末页后纠正越界页码。封面回退仍从当前排序的全清单取首个封面，不随页码/资源筛选变化。响应通过sequence及查询身份双重校验，旧清单变更回调不能替换新清单。
- 同查询后台刷新保持网格挂载，避免关闭嵌套影片时用加载占位压缩滚动高度；查询改变才显示加载占位。真实滚动保位、乱序响应及跨清单变更仍需交互测试验收，不能用源码正则测试代替。
- [本批测量](large-library-results/implementation/batch-d-playlist-300382.json)：30万合成库/3万清单，完整详情20,601,442B、93.89ms；60条首屏41,485B、8.13ms；末页41,111B、15.99ms。字节为JSON代理，非实测IPC时间；首次/热样本及其他限制与基准说明相同。[查询/页面快照](large-library-results/implementation/batch-d-playlist.patch)与[说明](large-library-results/implementation/batch-d-manifest.json)。
- 全量npm test一轮1,964通过、1跳过，build通过。随后按审查补了查询身份/静默刷新和更完整日期/资源夹具；末尾改动12项定向测试、renderer/browser类型及改动文件lint通过；尚未重新声称全量集成完成。
- PERF05仍是部分完成：影片页仍是宽DTO，元数据与页目前在同一次响应；独立元数据读取、视口虚拟化、演员/分类/候选分页均未完成。下一步先补本页交互验收，再继续其余页面。


## 后续批次 E：清单组件交互与窄卡片

- 新增真实React组件回归（非源码正则）：跨清单乱序响应、旧移出完成不刷新新清单、末页唯一影片删除后回前页、嵌套返回刷新保持同一个网格实例、同清单排序乱序响应，共5项。网格实例保持只证明不卸载，不替代浏览器实际滚动像素和窄窗口视觉验收。
- 引入 `VideoCard` 最小展示类型，PosterCard泛型保留原有完整Video调用方回调类型；清单getPage直接查询卡片列，不读取/返回简介、编辑字段或无用分类/资源计数。资源种类徽标排序仍复用原SQL。清单编辑表单明确只依赖元数据字段。
- 大清单测试为当前200条页写入每条64KiB简介，断言响应没有summary且在512KiB以内。完整字段仍由旧详情接口读取。代码/标题本身的异常超长输入预算尚待验证，没有宣称任意数据分布都满足字节上限。
- [30万库/3万清单复测](large-library-results/implementation/batch-e-cards-300382.json)：60卡首屏9,718B、9.19ms；末页9,344B、17.00ms热中位数。前批约41KiB；全量仍约20.6MB。CPU争用可能影响小幅时间变化，不把9.19ms与前批8.13ms作确定退化结论。
- 最新全量 `npm test`：1,969通过、1跳过、0失败（1,970项），含pretest/lint/类型检查；`npm run build` 成功。未启动或修改用户数据库。
- 全量检查后另补清单工具栏窄窗口换行规则；该CSS改动尚待最终视觉验收。
- [本批源快照](large-library-results/implementation/batch-e-cards.patch)与[说明](large-library-results/implementation/batch-e-manifest.json)已保存。
- PERF05继续推进：清单页现在有界且使用窄卡片；独立元数据接口、视口虚拟化、演员/分类详情和选择器分页仍待实施。PERF06的全局缓存与选择模型也未完成。


## 后续批次 F：独立清单元数据

- 增加metadata/videoPage两个类型化读接口；videoPage只查询清单ID存在性、计数和当前卡片页，不读取简介、链接或封面回退。保留getPage组合入口，供需要同事务元数据/影片页快照的调用方使用。
- 清单UI以ID+排序作为单项元数据缓存键；普通翻页/资源筛选复用，排序改变（影响封面回退）、移出/更新/导入完成及嵌套返回强制刷新。请求范围与sequence校验保留。此处是局部页面缓存，尚未取代PERF06的全局修订/事件失效设计。
- 新增实际组件测试：翻页不请求元数据，移出后重新请求，末页校正的后续请求复用刚更新的元数据。数据库测试用长简介验证影片页不含元数据，且不执行元数据、链接、封面回退SQL。
- [复测结果](large-library-results/implementation/batch-f-metadata-300382.json)：独立元数据169B/3.39ms/3条SQL；影片页9,550B/7.74ms/3条SQL。组合读取9,718B/10.67ms/6条SQL，仅首载或强制刷新需要两类查询；不宣称拆接口使总首载成本下降。
- npm test：1,971通过、1跳过、0失败（1,972项），含类型/lint/边界检查；build成功。当前组件测试9项（最后3项晚于本轮全量检查）；规格复核发现强制刷新被筛选切换打断时会复用旧缓存，已在强制刷新开始清空缓存。新增延迟/null/排序封面测试通过；修正后的renderer类型和改动文件lint通过。真实浏览器滚动、视觉和全局跨窗口失效仍待验收。
- [源快照](large-library-results/implementation/batch-f-metadata.patch)与[说明](large-library-results/implementation/batch-f-manifest.json)已保存。下一步仍按全计划处理演员/分类/候选分页、图片、后台任务与其他未完成项；不把清单局部完成当作PERF05或整项目完成。

## 后续批次 G：扫描进度合并

- 扫描协调器的订阅广播改为首条立即、连续更新100ms合并，仅保留最后一条待发状态。完成、取消或失败退出前清除定时器并立即补发最后状态，再发布终态事件；终态刷新不受周期限制。原始逐文件 `request.onProgress` 回调、审计与持久化保持原频率。
- 通用发布器使用单调时钟，模拟时钟测试覆盖300,382次突发更新、持续更新间距和关闭后无迟到事件。协调器实际入口另覆盖300,382次逐文件回调全部保留、最终计数以及失败前的最后进度顺序。没有把合成事件测试写成真实文件系统或渲染耗时验收。
- 全量 `npm test`：1,978通过、1跳过、0失败。随后尝试在批量队列内部合并进度，导致3项持久化回归失败：内部监听器还用于逐项暂停/取消。已撤回该尝试，队列及其测试恢复原代码；扫描/演员持久化定向103项全部通过，最终保留的生产代码与上面成功全量检查一致。
- 批量进度仍待在面向UI的发送层合并，必须保留队列内部逐项通知和检查点，不可用降低写入频率替代恢复保证。该回归发现已作为后续实施约束；PERF01继续标记部分完成。
- [源快照](large-library-results/implementation/batch-g-progress.patch)与[证据清单](large-library-results/implementation/batch-g-manifest.json)已保存；快照相对HEAD，含之前批次的协调器汇总改动，不是增量补丁。
- 最终保留改动的 `npm run build` 成功，`git diff --check` 通过；Standards与Spec只读审查均无明确阻断问题。Windows/真实文件扫描/渲染端到端与完整计划验收尚未完成。

## 后续批次 H：STRM重定位候选索引

- 懒加载扫描期索引，以完整basename（保留原大小写语义）和官方规范target key定位候选；不再每个新增路径读取全库STRM。查询仍实时核查资源归属、root、missing/unknown和唯一候选，文件存在性不缓存。
- 同步STRM插入、目标更新和移动增量维护索引。数据库revision组合本连接total_changes、外部提交data_version和连接身份；未知写入、异常或无法确认的写后结果使索引失效。无正式schema/迁移变更。
- 审查发现待确认写入也会增加total_changes，导致交错扫描反复重建。已仅对确认不修改video_resources的pending写入保留索引，仍检查写前revision和外部提交，不能吞掉其他写入。规范审查无阻断；规格复核确认该缺口已修复。
- 10k、20k、300,382、600,764引用夹具分别验证N次查找只加载1次引用全集、读取N个匹配候选；另有20k同文件名/不同目标测试。真实扫描入口使用40条文件导入、整目录移动，以及40既有+40待确认+40新增混合扫描，逐轮仅1次候选全集SELECT，移动保留全部资源ID。双连接实测验证外部提交失效。定向76项通过；[原始测试输出](large-library-results/implementation/batch-h-target-tests.log)可复核。
- 仍有限制：初始化是同步O(S)读取和内存索引，尚未满足PERF08/10的主线程阻塞预算；同文件名且同目标的极端重复桶仍需检查多个路径。大量其他资源写入（例如本地影片与STRM交错导入）会保守重建，尚未将所有混合场景变成线性。没有将操作计数测试称为Windows/HDD、峰值内存或端到端性能验收。
- [源快照](large-library-results/implementation/batch-h-strm.patch)与[证据清单](large-library-results/implementation/batch-h-manifest.json)保存了复核边界。下一步继续处理剩余批量UI广播、分页/图片/持久化/工作线程等完整计划，不缩减目标。
- 最终全量 `npm test`：1,989通过、1跳过、0失败（1,990项），含pretest/lint/类型/打包检查；`npm run build` 和 `git diff --check` 通过。工作区尚未提交、推送或发布。

## 后续批次 I：批量刮削UI进度合并

- 启动/恢复影片和演员批量任务统一在controller的UI发送层合并进度，普通running状态100ms合并；首条、失败计数增加、非running状态立即发送。取消后的idle不会被吞掉。队列内部通知、逐条检查点和200条日志窗口保持原行为，未修改两个队列实现。
- 发布器在独占任务内创建，结束或拒绝时先flush最后值、解除listener，再释放协调器；已关闭发布器忽略旧回调。窗口发送异常被捕获，不改变任务持久化。任务本身拒绝时保留原进度语义，不伪造done；统一错误状态/恢复体验仍需随后台生命周期方案验收。
- 实际SequentialBatchQueue接入controller，覆盖video/actress启动与恢复、完成/暂停/取消，10k目标逐条检查点完整，新增失败即时发送，终态后无定时事件。另验证run拒绝、listener解除早于解锁、下一任务正常启动及旧回调隔离。原演员持久化恢复测试保留并通过。
- 全量 `npm test`：1,996通过、1跳过、0失败（1,997项），build成功。之后完善恢复分支和拒绝/解锁顺序测试，最终定向29项通过，node类型和改动文件lint通过。未声称真实渲染耗时、检查点写入字节或长期恢复预算已经达标。
- [源快照](large-library-results/implementation/batch-i-batch-progress.patch)、[证据清单](large-library-results/implementation/batch-i-manifest.json)及[定向输出](large-library-results/implementation/batch-i-target-tests.log)已保存。PERF01仍保留目标硬件和极端场景验收；其余工作包继续按完整计划推进。

## 后续批次 J：桌面图片异步读取与请求上限

- `media://` handler改为等待MediaAssetStore异步读取；磁盘读取使用fs.promises.readFile并传递请求signal，取消后不继续解码。同步业务读取入口保留；路径解析规则和明文/密文内容、MIME不变。
- 请求队列默认4个活跃读取、256个等待；排队取消直接移除，不打开文件；活跃读取在底层settle后才释放槽位。队列满返回503，普通读取失败404；HEAD成功和403/404/503均无正文，OPTIONS不读文件。忙碌响应不等同自动重试；真正超载时的UI重试体验仍需浏览器验收。
- 通过真实readForServeAsync入口验证取消时机，并将延迟的fs.promises.readFile委托至真实文件读取；默认容量及第261请求拒绝、取消容量复用、失败后可继续读取均有回归。另有禁止readFileSync的异步明文/密文读取测试，以及实际协议函数GET/HEAD/OPTIONS/错误响应测试。
- 定向36项通过；最终全量npm test为2,004通过、1跳过、0失败（2,005项），含边界/lint/类型/打包检查；build成功。规范及规格审查无剩余明确问题；[定向输出](large-library-results/implementation/batch-j-target-tests.log)、[源快照](large-library-results/implementation/batch-j-image-reads.patch)和[证据清单](large-library-results/implementation/batch-j-manifest.json)已保存。
- 本轮没有实现解密/密钥派生后台化、缩略图/字节缓存、Web图片异步化或单个大图片字节预算；初始化路径/设置操作也未全部异步化。队列限制的是请求数量，不是总字节峰值。尚无真实Windows机械盘、浏览器滚动/内存或p95证据；PERF07保持部分完成，完整计划继续执行。

## 后续批次 K：图片异步密钥派生与解密

- 桌面异步serve路径改用crypto.scrypt和Web Crypto AES-GCM；AVPK文件布局、密钥输入、nonce/tag与写入格式保持不变，无数据迁移。同步业务入口保留。API依据[Node Crypto文档](https://nodejs.org/api/crypto.html)与[Web Crypto文档](https://nodejs.org/api/webcrypto.html)；Node v24系列的[AES实现](https://github.com/nodejs/node/blob/v24.13.0/lib/internal/crypto/aes.js)使用原生异步job，而非在Promise内执行同步decrypt。
- 密钥派生与导入合并在途请求；失败可重试，reset前的旧任务不能回填原始密钥或清除新CryptoKey。取消在阶段边界检查，已开始的原生运算等待settle后丢弃结果；读取队列仍持有槽位，不能通过取消增加活跃运算数。
- 测试覆盖原格式的多种扩展名/空至1MiB内容一致、密文损坏、12路冷派生只调用一次scrypt、禁止同步读/KDF/decrypt的Store链路、KDF/import失败重试、reset成功/失败交错、KDF及decrypt阶段取消。Store测试直接计数readFile：crypto门闩释放前保持4次，最终5次；旧任务完成后重读新密钥不增加importKey调用。
- [合成基准](large-library-results/implementation/batch-k-crypto.json)在本轮测试/build句柄结束后重跑，Electron43.4.1/Node24.18.1：16MiB热密钥连续5次解密，同步总耗时25.01ms/最大计时器延迟25.33ms，异步35.85ms/3.40ms；16MiB冷密钥最大延迟39.16ms→17.21ms。收益主要是响应性，不是吞吐；仍有初始化、数据复制和GC成本。单轮1ms timer观察不是p95或真实UI/Windows/HDD验收。
- 复跑：`JAVDEX_CRYPTO_BENCH_OUTPUT=/tmp/crypto.json node scripts/run-electron-tests.mjs scripts/performance/asset-crypto-benchmark.ts`。脚本不属于日常测试发现范围，不访问用户图片/数据库。
- 全量npm test：2,008通过、1跳过、0失败（2,009项），build成功；随后补充的失败/reset/取消验收最终定向46项通过，node类型和改动文件lint通过。规范及规格复核无剩余具体问题。[源快照](large-library-results/implementation/batch-k-async-crypto.patch)、[清单](large-library-results/implementation/batch-k-manifest.json)、[定向结果](large-library-results/implementation/batch-k-target-tests.log)已保存。
- PERF07仍部分完成：Web读取、缓存/in-flight图片合并、缩略图、头像状态和单图/总字节/像素预算尚待实施。异步API不等于任意尺寸输入均不阻塞，不降低原计划验收门槛。

## 后续批次 L：Web图片异步读取与授权复核

- Web图片接入共享异步Store，复用桌面的读取/解密队列。Catalog只按影片ID和图片键查询封面、关联演员头像或关联sample的路径，不再逐图加载完整影片、全部标签、资产、统计和资源详情；读取前后各执行一次窄查询，保留active library和非隐藏membership条件。
- await后重查可见性、图片关联与路径；读取期间隐藏/归档影片、替换路径、解除演员关联或删除sample会拒绝返回旧图。该检查不承诺检测同一路径文件内容替换的每个瞬间；版本化/缓存失效仍待后续实现。
- HTTP响应close触发signal，Catalog原样传至Store，读取结束后再次检查会话及响应状态；登出/断连不会发送已完成但不再授权的字节。会话过期测试使用隔离server，在构造前注入时钟，保留连接开放并在读取期间推进过期时间，断言401；独立于主动销毁连接的登出测试。
- 队列满返回503，保持no-store及HEAD行为。桌面和Web共用4活跃/256等待限制，但尚未提供按设备配额或桌面优先级；多设备公平调度仍属PERF13验收。
- 全量npm test：2,023通过、1跳过、0失败（2,024项），build成功。随后补充会话过期和Catalog signal精确断言，最终Web定向39项、node类型和改动文件lint通过；规范及规格复核无剩余具体问题。
- [源快照](large-library-results/implementation/batch-l-web-images.patch)、[证据清单](large-library-results/implementation/batch-l-manifest.json)、[定向输出](large-library-results/implementation/batch-l-target-tests.log)已保存。仍未验收目标硬件、多设备p95、字节/像素上限、缩略图或缓存命中率；完整优化目标继续执行。

## 后续批次 M：有界图片字节缓存

- 接入原来未用于serve的字节缓存，保留256项/96MiB上限。签名覆盖解析后的绝对路径、mtime、ctime、size、dev、ino；热命中仍异步stat，不把“路径相同”当作内容未变。冷读在读取/解密后复查签名，读取期间文件改变时拒绝旧结果；显式invalidate推进revision，阻止此前开始的读取回填。
- 插入和返回时复制Buffer，防止调用方修改污染其他请求；替换更新LRU并正确扣除旧字节数。超过缓存总容量的单项不入缓存，也不清空其他热图。该限制仅针对缓存常驻正文，不是单图拒绝阈值或整个进程内存预算。
- 覆盖热图实际read/decrypt计数、mtime恢复后的原子替换、删除/恢复、根目录切换、在途修改/失效、Buffer隔离、LRU及字节容量。取消测试直接观察下一请求的stat尚未开始，避免新增异步stat掩盖提前释放槽位；热缓存stat等待期间取消不会返回缓存字节。
- [合成基准](large-library-results/implementation/batch-m-cache.json)：16MiB密文连续5次，冷应用字节缓存55.95ms、5次read/5次decrypt/10次stat；热缓存5.80ms、0次read/0次decrypt/5次stat。明文16MiB对应18.31ms→5.75ms。OS缓存和密钥均已热，样本是传输字节而非真实像素图片；不代表机械盘冷读、浏览器解码或p95。复跑脚本为`scripts/performance/asset-cache-benchmark.ts`，输出变量`JAVDEX_ASSET_CACHE_BENCH_OUTPUT`。
- 全量npm test：2,033通过、1跳过、0失败（2,034项），build成功。之后补充精确取消断言，最终定向54项、node类型及改动文件lint通过；规范及规格复核无剩余具体问题。[源快照](large-library-results/implementation/batch-m-image-cache.patch)、[证据清单](large-library-results/implementation/batch-m-manifest.json)、[定向输出](large-library-results/implementation/batch-m-target-tests.log)已保存。
- 仍未合并同图并发未命中请求；每次命中仍有stat和防御性复制。文件元数据签名不是对任意外部恶意保留元数据改写的内容认证。单图/在途/响应字节、像素预算、缩略图、多设备调度和头像状态仍待实施，完整计划继续执行。

## 后续批次 N：同图并发请求合并

- 同一绝对路径和cache revision的在途读取共用一次文件读取/解密；flight完成即删除，不成为第二个永久缓存。合并发生在原4活跃/256等待队列内部，不额外创建无限订阅队列。排队请求随后通常通过热缓存完成。
- 单个消费者取消仅拒绝自己；最后一个消费者取消才abort底层，并继续占有一个槽位直到工作settle。旧flight清理使用对象身份，不能删除同键新flight；显式invalidate后的请求用新revision，不加入旧读取。消费者Buffer互相隔离。
- Store实际12个请求中取消1个，其余11个正常完成，仅1次read/1次decrypt。补齐全部消费者取消、失败传播后重试、旧任务与同键新任务交错、invalidate期间新请求独立执行。原4槽位测试改为4个不同路径，避免合并掩盖并发限制。
- [合成基准](large-library-results/implementation/batch-n-flights.json)：1MiB和16MiB明文/密文的12请求冷应用缓存批次均仅1次正文read，密文仅1次decrypt，4次stat；16MiB密文批次约22.90ms。没有旧版本同批次时延对照，不作倍数收益结论；非Windows/HDD、真实图像像素或p95验收。脚本延续`scripts/performance/asset-cache-benchmark.ts`。
- 全量npm test：2,038通过、1跳过、0失败（2,039项），build成功；随后补充的失效/全取消验收最终45项定向通过，node类型及改动文件lint通过，规范/规格复核无剩余具体问题。[源快照](large-library-results/implementation/batch-n-image-flights.patch)、[证据清单](large-library-results/implementation/batch-n-manifest.json)、[定向输出](large-library-results/implementation/batch-n-target-tests.log)已保存。
- 每个消费者仍持有独立响应Buffer；缓存96MiB与队列数量上限不构成输入、原生运算或响应总字节上限。单图/在途/像素预算、缩略图、头像状态、多设备调度和其余工作包仍按完整计划继续。


## 后续批次 O：单图编码字节预算

- 桌面/Web共享serve路径增加64MiB编码文件上限（密文含封装头）。超过限制返回413，Web保留no-store，HEAD不返回正文。同步业务读取不在本批修改范围。
- 打开文件后fstat，再按该尺寸固定分配；每次读取最多1MiB，末尾额外探测1字节。增长或截断拒绝结果，不跟随文件增长扩容；原有读取前后签名校验继续保留。所有成功、取消、stat/读取失败路径等待句柄关闭。
- 实际临时文件测试覆盖空文件、恰好上限、多块读取、超限零read、增长/截断、I/O失败、open后取消、stat失败及非普通文件。Store分别阻塞4个FileHandle.read/close，取消后请求未settle且第五请求零stat/open，释放后所有fd=-1；明文与密文超限不打开或解密。协议与真实HTTP验证413/HEAD/no-store。
- 全量npm test：2,050通过、1跳过、0失败；build成功。随后测试补充后的最终定向71项、node类型及改动测试lint通过。规范审查无阻断；规格审查提出的read/close等待和stat失败关闭验证已补齐并通过复核。
- [合成复测](large-library-results/implementation/batch-o-cache.json)：16MiB密文冷应用缓存5次49.25ms、5次open/5次decrypt；热缓存5次5.55ms、零open/decrypt；12路并发冷缓存20.28ms、1次open/decrypt。指标由readFile调用数改为openCalls，不计句柄fstat/分块read，不能当作全部文件系统操作次数；非Windows/HDD/p95。时间差异不据此认定固定收益。
- [源快照](large-library-results/implementation/batch-o-bounded-read.patch)、[清单](large-library-results/implementation/batch-o-manifest.json)、[定向测试](large-library-results/implementation/batch-o-target-tests.log)已保存。4活跃读取的原始输入分配各不超过64MiB（另加探测字节），但缓存、防御性复制、原生解密及响应内存另计；总字节/像素预算、缩略图、头像状态、其余工作包和目标硬件验收仍未完成。


## 后续批次 P：异步图片头检查与单帧画布预算

- 引入固定版本Sharp0.35.4；共享serve路径在读取/解密后、写入字节缓存前异步读取metadata，检查单帧画布不超过67,108,864像素（64×1024×1024）。像素超限映射桌面/Web413，HEAD空正文，Web仍no-store。MIME取实际头信息，允许JPEG/PNG/WebP/GIF/AVIF；损坏或不支持格式拒绝返回。
- [Sharp metadata文档](https://sharp.pixelplumbing.com/api-input/)说明该接口读取头信息、不解码压缩像素；此处pages=1，metadata的默认limitInputPixels关闭后由业务类型化限额检查，不能把这个设置复用给未来缩略图解码。实际解码必须另设limitInputPixels、并发与内存预算；[构造参数](https://sharp.pixelplumbing.com/api-constructor/)也明确尺寸限制依赖输入metadata的真实性。
- 旧Store JPEG夹具存在损坏头，已换成真实生成的有效JPEG；文件变化测试也改用有效图片，继续验证相同mtime替换/根路径变化/在途失效。覆盖五种格式、微小编码内容的大尺寸头、精确上限、损坏与不支持格式、加密/明文超限拒绝和替换恢复、热缓存零metadata。真实3帧GIF/WebP证明pages=1时height为单帧高度，不把总帧高误当单帧。
- 新增metadata门闩至Store的4活跃取消验证：取消后Promise未settle、第五请求零stat/open，元数据处理完成后才继续。规范及规格审查无剩余具体问题。
- 全量npm test：2,060通过、1跳过、0失败；build成功。后续测试补充后最终83项定向、node类型及改动测试lint通过。
- 打包增加sharp与@img的asarUnpack。实际macOSarm64目录包构建完成，使用包内可执行文件的RunAsNode模式加载包内Sharp，对五种格式执行metadata与resize，见[成品冒烟记录](large-library-results/implementation/batch-p-packaged-smoke.json)。脚本`scripts/performance/sharp-packaged-smoke.cjs`提供复跑入口；本次没有启动用户软件或读取用户库。Windows/Linux成品尚未验证，不宣称跨平台发布验收通过。
- [缓存复测](large-library-results/implementation/batch-p-cache.json)换为32px PNG加合成尾部字节，非前批任意正文夹具：16MiB密文冷缓存5次58.23ms，热缓存5次5.88ms，12路并发冷缓存23.75ms、1次open/decrypt。仅说明接入metadata后热命中和合并仍有效；无真实渲染/Windows/HDD/p95，不能直接跨夹具对比提速。
- [代码快照](large-library-results/implementation/batch-p-pixel-budget.patch)、[清单](large-library-results/implementation/batch-p-manifest.json)、[定向测试](large-library-results/implementation/batch-p-target-tests.log)已保存。单帧声明画布限制不等于动图累计帧/并发解码/响应总内存预算；原同步业务inspection仍会调用nativeImage，缩略图和头像状态也待实现。PERF07与完整计划继续保持部分完成。


## 后续批次 Q：按需缩略图与卡片接入

- 新增320/640/1280有限档位，以单帧、EXIF方向校正、等比内接、不放大小图生成WebP；默认质量82。解码设64×1024×1024输入像素上限、两路活跃队列，仍位于原四路serve队列之内。取消等待原生任务完成后才释放槽位，失败不入缓存。不持久写出解密后的缩略图文件。
- cache和flight包含变体及算法版本；原图/全部档位共享96MiB/256项，按路径失效清除所有变体。文件签名复查保留，替换、读取中变更或旧revision不能填回过期图。档位增加会占用相同缓存条目预算，不另开无限缓存。
- 桌面PosterCard（含大清单卡片）与Web网格请求640档；详情预览及编辑/分析入口仍取原图。协议与Web只接受有限size，非法参数400，HEAD/认证/授权复核保持原合同。当前没有给头像、分类、所有画廊入口接入缩略图，也没有宣称全软件图片链路完成。
- 测试覆盖方向/比例/透明度/不放大、动画首帧、取消后两槽位保留，加密同图12请求仅一次读取与生成，变体隔离、全部失效、替换恢复、原图字节保持。真实Catalog/HTTP/协议逐层验证size传递，React组件断言实际卡片img URL。
- 最终全量npm test：2,072通过、1跳过、0失败；build成功。首轮曾因测试参数缺类型、Web运行时不支持@shared别名而失败，已修正并重新通过。最终定向103项通过，规范和规格审查无剩余具体问题。
- Chrome实际浏览器检查320×844、390×844、844×390、1280×800全部通过，覆盖卡片缩略图URL以及原有预览、键盘、窄屏和登录配对检查；[浏览器日志](large-library-results/implementation/batch-q-browser.log)。使用合成图片路由，不是Windows/HDD真实数据或浏览器图片性能测试。
- [合成基准](large-library-results/implementation/batch-q-thumbnail.json)：随机噪声JPEG原图2400×1600、3,896,737B；640档640×427、99,404B。原图服务2.52ms，冷缩略图48.89ms，热缩略图0.13ms且零open/decode。缩略图降低响应字节和浏览器待解码像素，但增加首次服务端生成成本；单次热OS样本，不作p95或固定提速承诺。复跑脚本`scripts/performance/thumbnail-benchmark.ts`、输出变量`JAVDEX_THUMBNAIL_BENCH_OUTPUT`。
- [源快照](large-library-results/implementation/batch-q-thumbnails.patch)、[清单](large-library-results/implementation/batch-q-manifest.json)、[定向测试](large-library-results/implementation/batch-q-target-tests.log)已保存。算法依据[Sharp resize](https://sharp.pixelplumbing.com/api-resize/)与[方向处理](https://sharp.pixelplumbing.com/api-operation/)文档，解码与metadata预算分开。
- 下一步继续其他图片入口、响应/原生总内存与头像状态，随后按剩余工作包处理分页、查询隔离、持久化和目标环境验收。本批不代表PERF07或完整计划完成；工作区未提交、推送或发布。


## 后续批次 R：演员、分类与画廊缩略图入口

- 演员卡片和影片演员头像使用320档，分类/清单列表封面使用640档，小型清单/分类图片候选使用320档。本地演员写真与影片样张网格使用640档，预览helper继续默认原图并保留localPath；远程来源无本地副本时仍使用原URL。
- 演员详情展示头像640，原图预览优先avatar_source_path，缺失时单独调用无size的avatar_path URL；不从显示缩略图变量回退。裁剪、人脸分析和编辑原图入口未改变。Web演员头像320、画廊640，预览数组保留原URL。
- shared URL helper不改写外部HTTP、协议相对URL、data和blob；避免给不支持size合同的源追加参数。浏览器合成broken图片路由改按pathname判断，保留查询参数后的404验证。
- 新增真实React演员卡片及两种画廊测试：列表图片为缩略图，点击后Lightbox接收无size的原图src和原始localPath；只替换portal/手势边界，不能当作完整桌面预览测试。演员详情source缺失fallback已静态核对，尚无整页交互验收。
- 本批全量npm test：2,072通过、1跳过、0失败；build成功。随后新增组件测试后定向4项通过（3组件+1共享URL），所有类型及新增测试lint通过。规范审查无阻断；规格复核确认画廊点击验收缺口已关闭，并保留上述演员详情证据边界。
- 实际Chrome在320×844、390×844、844×390、1280×800及登录配对检查通过，新增断言预览图片URL不含size；[浏览器日志](large-library-results/implementation/batch-r-browser.log)。使用合成图片路由，不代表原始图片加载性能或目标Windows环境已验收。
- [源快照](large-library-results/implementation/batch-r-image-entrypoints.patch)、[清单](large-library-results/implementation/batch-r-manifest.json)、[定向输出](large-library-results/implementation/batch-r-target-tests.log)已保存。编辑器候选/预览胶片条、头像状态、响应/原生总内存与其余数据库和任务工作包仍待推进；没有将本批入口扩展视为全部图片或完整计划完成。


## 后续批次 S：批量刮削检查点固定清单与进度分离

- `batch-scrape-job.json`升级任务文件formatVersion=2，引用按SHA256命名和校验的固定清单（jobId/kind/request/targets）；每项仅重写进度、计数和现有最近日志。显式progress-only API保持固定定义，范围协调改写仍走full-save。不是数据库schema迁移，没有修改业务数据库版本。
- 旧单文件任务仍可读取，下一次保存才迁移；先写清单，再原子提交指针。临时文件同目录创建、fsync、rename；POSIX额外同步目录，Windows没有照搬目录fd操作。缓存只在提交成功后更新；结果不确定时清缓存，下一次按磁盘实际状态恢复。
- 缺失/校验失败清单、异常游标/目标/total被拒绝并保留任务文件，不能按“没有任务”继续覆盖。初始化捕获恢复错误以保留软件可用性，状态/继续操作仍报告错误。已有损坏任务的自动修复或专门恢复界面不在本批实现范围。
- 检查点失败停止后续目标并置队列paused；不提前推进耐久游标。实际队列故障测试验证业务项已执行而checkpoint失败时，恢复会重复该项，不会漏项；仍需目标业务幂等处理，不能宣称exactly-once。
- 清单垃圾清理只在full-save/clear成功提交之后执行，保留当前引用；清理失败不推翻已提交结果。指针替换/删除后目录同步失败时不清理清单，并重置缓存以免继续使用旧任务。真实进程强杀遗留临时文件的回收和Windows断电矩阵仍待验收。
- [实际写入量测试](large-library-results/implementation/batch-s-write-volume.json)：1,000目标写409,049B，2,000目标写822,049B，每个任务固定清单仅写1次。使用真实临时文件/fsync/rename、固定空日志，隔离目标数组重写成本；不能当作含200条滚动日志的完整任务总量，也未覆盖10k/20k/100k或目标HDD性能。
- 新增故障覆盖write/fsync/rename、清单提交后指针失败、rename后目录sync失败、unlink后目录sync失败、清理枚举失败、损坏游标与清单、至少一次重试。既有演员状态协调/恢复与控制器回归通过。规范/规格审查发现的越界游标及不确定删除缓存问题已修正并复核。
- 最终全量npm test：2,087通过、1跳过、0失败；build成功，git diff --check通过。[完整测试日志](large-library-results/implementation/batch-s-full-tests.log)、[源快照](large-library-results/implementation/batch-s-checkpoints.patch)、[清单](large-library-results/implementation/batch-s-manifest.json)已保存。
- 兼容边界：旧版本不能读取formatVersion=2任务检查点；回退版本前应先完成/终止新任务，或使用迁移前保存的原任务文件，不能只把formatVersion改回去。业务数据库未变不等于暂停任务文件可供旧版本恢复。仍未发布或修改用户数据。
- PERF09继续部分完成：目标仍在内存加载，日志依旧最多200条但没有严格字节预算；加密别名和Agent日志的全量重写、目标硬件/长跑/真实故障恢复均待推进。完整计划保持进行中。


## 后续批次 T：加密路径别名增量日志

- 原别名文件名不变，新增带加密快照与逐条加密set/delete的日志格式；热读取复用带文件签名的Map，每次变更仅追加一条记录并fsync。累计至少4,096条且增量字节不少于快照时，才压缩为新快照，避免不断重写增长中的全集。
- 旧AVPK全量JSON只读时不改写；首次实际变更通过同目录临时文件、fsync、rename迁移，POSIX额外同步目录。完整帧头或密文损坏拒绝加载和覆盖；不完整末尾恢复到最后完整记录，下一次追加前截去残尾。初始快照缺失/截断拒绝恢复为空表。
- 追加失败清缓存，下一次读取实际磁盘状态；完整写入后fsync失败可能已提交，因此重试相同值不重复追加。压缩失败不推翻此前已提交的增量，外部文件替换会使缓存失效。该实现不提供多进程写者协调，也不能把历史已提交尾部被截断与未写完尾部完全区分。
- 新增10项测试覆盖旧格式迁移/rename失败保留、热路径零正文读取/无效变更零追加、删除和清空、部分写入重试、完整密文损坏保留、缺失快照拒绝、fsync结果不确定、4,096次真实更新压缩、压缩失败后恢复及外部替换。既有资产加解密与目录迁移回归通过；规范/规格静态复核未发现具体阻断。
- 最终全量npm test：2,097通过、1跳过、0失败；build成功。[完整日志](large-library-results/implementation/batch-t-full-tests.log)、[源快照](large-library-results/implementation/batch-t-alias-journal.patch)、[清单](large-library-results/implementation/batch-t-manifest.json)已保存。
- [合成基准](large-library-results/implementation/batch-t-alias-benchmark.json)：1,000/2,000别名日志为111,800/225,800B，加密调用1,000/2,000次；逐项重载核对全部映射。真实临时文件/fsync，尚未触发压缩；这是文件大小和加密调用数，不是物理磁盘总写入量。计时与完整回归重叠，不作时延收益或p95结论。复跑脚本`scripts/performance/alias-journal-benchmark.ts`，输出变量`JAVDEX_ALIAS_BENCH_OUTPUT`。
- 兼容边界：旧软件不能读取新日志；回退需保留升级前别名文件或另做完整导出转换，不能仅修改格式标识。冷启动仍全文件同步读取、解密回放并保留完整Map；每项fsync仍可能阻塞主循环。文件转换与DB引用交割、真实强杀/断电、Windows/HDD及10k/20k/100k验收仍待完成，BG08/PERF09没有标记全部完成。


## 后续批次 U：Agent 索引游标与有界 journal 分页

- 插件开发（活动/持久化快照两分支）、元数据采集和媒体库整理统一通过`getProductJournalCursor`读取指定run最后seq。SQL只选seq，使用既有`(run_id, seq)`覆盖索引，空日志返回0；不再为获取游标读取和解析完整journal。
- `readProductJournal`改为默认/最大500条，严格校验非负安全整数游标与1–500页大小，`seq > afterSeq ORDER BY seq ASC LIMIT ?`续页。已有生产调用点全部核对并改为游标查询；读取历史时必须以实际末项seq续页，不能把默认一页当作完整历史。没有删除或截断已有日志。
- 100,000条损坏payload夹具仍能读取正确游标：断言一次窄SELECT、覆盖索引、无临时排序和零JSON.parse；真正读取损坏正文仍报错，不掩盖数据损坏。1,001条目标事件与另一run交错，500/500/1分页验证序号间隙、顺序、隔离、无重复/遗漏及非法参数拒绝。
- 三个服务实际snapshot方法的集成测试禁止全journal调用并检查索引游标返回；插件额外覆盖活动会话移除后读取持久化record的分支。这里只替换Store接口，不是完整UI交互或目标环境延迟测试。
- 全量npm test：2,102通过、1跳过、0失败；build成功。随后补充的插件持久化分支最终28项定向、node类型和改动测试lint通过。初始组合定向41项通过。规范审查无具体问题；规格审查指出的持久化分支证据缺口已补齐并复核。
- [完整日志](large-library-results/implementation/batch-u-full-tests.log)、[组合定向](large-library-results/implementation/batch-u-target-tests.log)、[最终插件测试](large-library-results/implementation/batch-u-plugin-final.log)、[源快照](large-library-results/implementation/batch-u-agent-journal-cursor.patch)、[清单](large-library-results/implementation/batch-u-manifest.json)已保存。
- 本批没有修改数据库schema、ExecutionHistory加密/哈希、工具授权或恢复generation。workLog仍在产品状态中全量复制和重写，snapshot数组尚未分页，冷恢复与每页payload字节上限仍待处理；因此BG14/PERF09继续部分完成，不把游标查询优化视为整个Agent日志工作包完成。


## 后续批次 V：插件工作日志追加存储与事务引用

- PluginDeveloper产品状态升级为schema2，workLog使用`journal-v1`区间与条数引用。每次只追加新条目，日志追加和产品状态更新在同一SQLite事务提交，失败一起回滚。沿用既有product journal，不新增数据库表或修改user_version；旧领域事件仍保留，当前不是对所有重复事件记录做去重。
- schema1内联日志继续可读；首次状态更新把完整旧前缀迁到追加流并校验前缀未变，新建run首次更新前可暂存初始内联消息。新schema不能直接交给旧客户端恢复，回退应使用升级前完整数据或另行转换，不能只修改版本号。产品文档已同步更新。
- 读取引用按已提交区间、最多500条逐页获取，校验条目index、总数和端点。throughSeq作为SQL上界，引用之后的损坏/无关payload不会影响读取这份历史；缺失行/格式异常拒绝恢复，不当作空日志。当前仍将所有页组装成数组，没有宣称冷恢复或导出内存有界。
- 修复本批引用化暴露的取消交互：AgentExecution取消只改状态并保留最新durable productState，避免旧runtime引用覆盖领域层新日志；恢复失败处理优先保留已迁移的新状态。否则同一index可能被重复追加，令恢复/导出失败。规范及规格审查均指出该P1问题，修复后复核关闭。
- 故障测试覆盖旧前缀被改、日志收缩、损坏引用/缺行、追加中失败、引用更新失败、回滚后重试不重复。真实PluginDeveloper/AgentExecution/SQLite集成验证1000条引用后，领域层追加至1001但runtime尚未projection，随后无projection的abort与真实cancel、冷snapshot、导出、恢复再追加至1002均正确。仅模型runtime与测试实例路由替换，不调用模型或用户库。
- 追加1k/10k/100k条的[逻辑JSON写入](large-library-results/implementation/batch-v-log-write-volume.json)：产品状态累计110,786/1,127,788/11,477,790B，journal累计131,780/1,337,780/13,577,780B。真实内存SQLite触发器/行数据计数，每种规模完整回放核对；外层事务摊薄测试提交，不代表WAL/物理磁盘总写入、fsync时延或目标Windows/HDD。实际1000领域事件另断言不structuredClone全workLog，落盘状态只含引用。
- 全量npm test：2,108通过、1跳过、0失败；build成功。之后增加“legacy迁移成功、runtime重开失败”的恢复catch测试，最终30项插件定向、node类型及改动测试lint通过；断言schema2引用没有被旧状态覆盖，inactive snapshot仍保留全部原日志。规格复核确认该故障分支证据缺口关闭。
- [完整日志](large-library-results/implementation/batch-v-full-tests.log)、[组合定向](large-library-results/implementation/batch-v-target-tests.log)、[最终插件测试](large-library-results/implementation/batch-v-plugin-final.log)、[源快照](large-library-results/implementation/batch-v-agent-work-log.patch)、[清单](large-library-results/implementation/batch-v-manifest.json)已保存。
- 仍需推进：实际recovery-generation重建与新日志引用组合专项测试；session/snapshot/export完整历史内存、UI日志分页、payload字节预算；元数据activities中长期reasoning历史的复制/重写；Windows/HDD、进程强杀和完整长期矩阵。既有ExecutionHistory加密/hash/codec/generation回归保持通过，但不能替代新增组合覆盖。BG14/PERF09与完整计划继续部分完成，未提交/推送/发布。


## 后续批次 W：日志引用与 checkpoint 重建组合验收

- 只新增测试，生产实现保持V。真实AgentExecution、SQLite与追加日志模块组合，1,001条历史跨越多页，覆盖checkpoint重建成功、ExecutionHistory哈希失败、runtime重建失败、未对账写操作阻止恢复四种情况。模型runtime与cipher使用可控测试替身，不调用用户软件或外部模型。
- 成功路径验证传入rebuild的恢复payload/codec、generation从0到1、原日志引用/内容不变，重建后继续追加仍完整。失败路径验证generation保持0、重建调用次数正确、同一代再次尝试被拒绝；所有路径比较操作前后的ExecutionHistory和工具账本，确认没有因日志迁移改写或丢弃它们。
- 最终组合定向47项通过，node类型及改动测试lint通过。初始执行器13项通过后修正了测试夹具的联合类型构造，再运行最终组合。此次只改测试，没有重复全量测试或构建；最近生产集成证据仍为V批次。规范及规格复核无具体阻断，V中宿主恢复代次与新日志引用组合的专项缺口关闭。
- [定向日志](large-library-results/implementation/batch-w-target-tests.log)、[测试快照](large-library-results/implementation/batch-w-recovery-log-tests.patch)、[清单](large-library-results/implementation/batch-w-manifest.json)已保存。仍不等于真实Pi checkpoint文件、OS安全存储、Windows/HDD、进程强杀/断电或端到端长期验收；日志UI/历史内存与其余完整工作包仍待完成。


## 后续批次 X：Agent 恢复按产品筛选与窄 ID 分页

- 三个产品不再各自加载并解析全部未关闭run。Store先按useCase和可选status筛选；插件恢复只取原来的created/running/recovering/waiting_user，元数据和媒体库整理保持各自全部非closed语义，避免误排除ready草稿等需恢复状态。旧全量枚举API及生产调用已移除。
- SQLite TEMP表仅固定候选ID，按原updated_at顺序、rowid作为并列顺序；128个ID一页，完整config/product逐条getRun。先固定顺序，避免恢复时updated_at改变造成跳项/重复，后续新建run不混入；加载时再检查关闭/删除/状态变化。不跨异步runtime恢复持有主库读事务。
- plugin清理收集和playlist importer旧任务关闭改用ID-only枚举，避免为关闭或收集ID解析产品正文。TEMP表在完成、break和异常时finally删除，使用独立随机名称。没有更改持久schema或删除业务历史。
- 20,000条无关/已closed任务的config/product使用损坏JSON，260条符合目标条件的任务仍可恢复；初始取一条只调用一次getRun，完整目标枚举只加载260条。ID-only还验证可以枚举状态已settled但正文损坏的旧任务。跨260条分页期间更新已处理任务、关闭后续任务、创建新任务，顺序和集合仍正确；解析所属任务异常后临时表也被释放。
- 全量npm test：2,116通过、1跳过、0失败；build成功。随后强化目标全量getRun计数断言，最终13项Store定向、node类型及改动测试lint通过。初始组合定向43项通过。规范/规格审查无具体阻断；并列updated_at的rowid顺序目前仅静态核对。
- [完整日志](large-library-results/implementation/batch-x-full-tests.log)、[组合定向](large-library-results/implementation/batch-x-target-tests.log)、[最终Store测试](large-library-results/implementation/batch-x-store-final.log)、[源快照](large-library-results/implementation/batch-x-agent-recovery-enumeration.patch)、[清单](large-library-results/implementation/batch-x-manifest.json)已保存。
- TEMP ID集合仍为O(M)，由SQLite管理并可能随temp_store设置落盘；这不是固定总内存上限。候选ID初始查询与排序仍可能阻塞主循环，恢复后的active对象和日志内存仍会累积；首窗前任务延迟恢复、历史归档、Windows/HDD/p95等仍待完成。BG15与完整计划继续部分完成，未提交/推送/发布。


## 后续批次 Y：工作区异步清理与持久重试队列

- `pluginWorkspace.remove`改为异步`fs.promises.rm`，retirement等待删除完成，同一次操作逐个处理工作区。移除主进程同步递归删除；不宣称Node内部文件操作队列或多个并发IPC清理请求已设统一上限。
- schema16新增独立`agent_resource_cleanup(run_id, requested_at)`队列表，PK/FK关联run。关闭前登记意图，删除成功后才清记录；晚到的产品状态写入不会清掉队列。正常恢复仍排除closed，清理枚举额外包含closed-pending；下一次清除/清理终态会话可继续处理。
- 清理的状态判断改为窄`getRunStatus`，不解析产品/config JSON。测试验证正常状态文件锁失败、关闭后保留队列、晚到状态写、新控制器重试，以及损坏状态工作区自身删除失败后再重试。损坏原始product/config保持不变；不存在通过替换为空JSON来“修复”历史的行为。
- 初始JSON内嵌标记方案在审查中发现P2：损坏JSON无法登记标记，阻断清理，并给普通状态写入带来额外解析成本。已替换为独立表，普通`updateProductState`恢复原SQL；规范/规格复核确认问题关闭。
- V15→V16迁移测试比较全部既有schema和业务/会话行不变，覆盖FK/cascade、integrity_check、foreign_key_check、建表后注入失败时DDL和版本号一起回滚、重新升级成功。夹具由当前schema去掉新增表构造，为合成V15，不是客户数据库或发布版数据文件实物。
- 最终全量npm test：2,120通过、1跳过、0失败；build成功。包含上述最终双故障重试与V16迁移测试；异步门闩测试验证调用方等待删除、事件循环可继续以及零rmSync。[完整测试](large-library-results/implementation/batch-y-full-tests.log)、[源快照](large-library-results/implementation/batch-y-workspace-cleanup.patch)、[清单](large-library-results/implementation/batch-y-manifest.json)已保存。
- 兼容边界：本工作分支数据库版本现为16，官方0.6.2为15，升级后的数据库不能直接由旧版本打开；本批未实现降级，也不能只改user_version。尚未启动用户库、提交、推送或发布。
- 仍需真实Windows文件锁/进程强杀/断电、大工作区删除的内存与时延、并发清理准入、启动自动排空与历史保留策略验收。BG15与完整计划继续部分完成。


## 后续批次 Z：清理准入与退出等待

- 同一个PluginDeveloper控制器的clear/discard共用清理准入门；执行前同步登记在途操作，额外请求立即提示正在清理，不建立无界等待队列。成功/失败都在finally释放准入门，未退出的原实例可重试。
- dispose先禁止新清理，再等待已接纳操作settle，随后释放其他运行资源。appMain原有退出链在产品dispose完成后才关闭数据库，因此成功清理能够删除队列记录，失败清理能留下可重试意图；不会在异步删除结束前关闭连接。
- 真实SQLite与临时工作区、受控异步rm测试覆盖clear/discard作为首请求、两入口重叠拒绝、零额外rm、退出等待、退出期间新请求拒绝、失败保留清理队列，以及同实例或退出后新实例重试。这里的并发上限属于主应用单例控制器，不是跨进程锁或Node内部文件请求总数上限。
- 全量npm test：2,123通过、1跳过、0失败；build成功。首轮插件定向34项通过；规范/规格审查无具体阻断。[完整日志](large-library-results/implementation/batch-z-full-tests.log)、[定向日志](large-library-results/implementation/batch-z-target-tests.log)、[源快照](large-library-results/implementation/batch-z-cleanup-admission.patch)、[清单](large-library-results/implementation/batch-z-manifest.json)已保存。
- 完整测试和构建结束后，另运行[实际临时目录基准](large-library-results/implementation/batch-z-cleanup-benchmark.json)：1,000文件同步/异步删除31.29/22.01ms，最长5ms定时器间隔32.26/6.78ms；10,000文件318.86/239.22ms，最长间隔318.99/11.23ms。异步场景在删除完成前定时器即可执行，原同步调用不能。脚本`scripts/performance/workspace-cleanup-benchmark.ts`，输出变量`JAVDEX_CLEANUP_BENCH_OUTPUT`。
- 上述为macOS本地临时目录、合成小文件、每种情况单次测量，未清OS缓存；同步建夹具在测量区间外。不是p95、真实Windows/HDD或总内存验收，不据此承诺固定加速倍数。目录ID集合、原生rm内部排队、跨进程协调、启动自动清理和保留策略仍待推进；完整计划继续进行中。


## 后续批次 AA：手工标签计划修复与同库统计探针

- 将手工标签的可见计数与任意manual关联判断分离，避免缺统计时逐关系扫描materialized members。1万同规则夹具由6,365.76ms降到10.68ms；保留零可见计数、共享去重和manual来源口径。4项标签测试通过，新增独立oracle覆盖80影片的共享/隐藏/归档/混合来源，在无统计、optimize、ANALYZE下全等。
- 新统计探针在同库维护前后比较完整结果、记录EQP及统计行。审查指出初始overlap阶段只覆盖两项，已改为写入后重新采集完整矩阵；最终两种模式均通过单库25项、overlap27项，analysis_limit恢复原值。规范/规格静态复核无剩余阻断。
- 单库列表统计维护后发生整段排序计划变化，Web无统计查询则仍为秒级。300382有统计独立基准手工标签1,374.96ms、多库首页708.23ms；不能宣布大库聚合已达标。具体数据、下一步覆盖索引/窄名称接口/独立连接调度方案见[专题报告](large-library-statistics-probe.md)。
- 全量npm test：2,124通过、1跳过、0失败；build成功。[完整日志](large-library-results/implementation/batch-aa-full-tests.log)、[源快照](large-library-results/implementation/batch-aa-tags-statistics.patch)、[证据清单](large-library-results/implementation/batch-aa-manifest.json)已保存。两种最终探针和30万基准顺序运行，全量测试/构建在基准结束后执行。
- AA没有新增生产统计钩子或数据库迁移；现有schema16来自Y。未访问用户库、提交、推送、发布。测试仍为本机合成数据，缺Windows/HDD/p95/长期并发；完整15工作包、42风险计划继续部分完成。


## 后续批次 AB：倾斜标签计划与覆盖索引评估

- AA的关联EXISTS在倾斜统计下仍会逐标签扫描origin索引。改为非关联manual标签IN集合，保留计数/归属语义；10k倾斜夹具546.08ms降到7.34ms，300382新倾斜查询268.34ms。旧大倾斜计划未强跑，保护检查在建库前拒绝；修复后显式开放才验证大倾斜。
- 取舍明确：300382全manual均匀夹具由338.94ms变为436.38ms，增加一次集合构建；稀疏manual由275.60ms降至80.37ms。没有用“所有查询都更快”描述修复。
- 新基准比较两种覆盖索引，10组旧查询、12组新查询实验通过；候选仅修改临时库，完整结果/外键/完整性均核对。origin-first净空间增量约4.0～5.4MiB，小于video-first约24.7～26.2MiB，仍增加写入量且稀疏查询无一致收益。推荐继续验证origin-first的完整矩阵和迁移，不直接修改正式schema。
- [专题报告](large-library-tag-index-evaluation.md)、[源快照](large-library-results/implementation/batch-ab-tags-index-evaluation.patch)、[清单与原始证据](large-library-results/implementation/batch-ab-manifest.json)已保存。全量npm test2,124通过、1跳过、0失败；build成功；规范/规格审查无具体阻断。
- 下一步：影片标签添加弹窗按需加载不附计数的分页候选，处理搜索/错误/过期响应；全量聚合的修订缓存、查询隔离和目标Windows验收仍待推进。AB无新生产索引/迁移，未操作用户库、提交、推送、发布；完整目标继续进行中。
- 随后完整主基准复核：optimize和ANALYZE各通过25/27项同库比较，300382有统计完整矩阵通过；该较宽目录夹具手工标签1,451.83ms，仍需进一步优化。原始结果已追加AB清单，不能与较窄标签专用夹具的436.38ms混用。


## 后续批次 AC：已选标签窄名称查询与缺失重试修复

- 新增tags.labels类型化IPC/服务/Repo，最多100个正安全整数ID，按tags主键取显示标签；不读取影片关系或计算video_count。显示标签最多128个Unicode码点加省略号；完整数据库名称不变，DTO不得用于编辑/标识。100个控制字符长名称的JSON仍小于96KiB。
- LibraryPage原来在挂载、范围变化、详情返回和缺名称时反复list全部标签计数；删除标签仍留在URL时，missing检测与每次新Map可能构成循环。现以所选ID和是否激活驱动一个快照，缺失/失败回退ID，不以返回内容触发重试；切换筛选/失活后旧响应不得落地，返回详情外列表时重新查询。取消使用全量名称Map和路由携带的全文名称作为缓存。
- 测试覆盖10000未选标签下PK查询/无关系聚合、重复/删除ID、空请求零SQL、边界参数、控制字符载荷和emoji不截坏；React hook覆盖空/失活、缺失/错误不循环、旧筛选与失活响应、详情返回。IPC schema覆盖数量和安全整数。27项定向通过；全量npm test2,131通过、1跳过、0失败；build成功；规范/规格静态审查无具体阻断。整页实际chip移除与路由联动尚未做交互验收。
- 全量测试/构建结束后，独立300382有统计主基准通过：3标签名称0.01846ms/76B，100标签0.04883ms/2685B，对照全标签计数569.34ms/46,787B。为本机SQL函数热运行和JSON字节，不是IPC端到端/冷盘/p95/Windows结果。[完整日志](large-library-results/implementation/batch-ac-full-tests.log)、[基准](large-library-results/implementation/batch-ac-labels-300382.json)、[源快照](large-library-results/implementation/batch-ac-selected-tag-labels.patch)、[清单](large-library-results/implementation/batch-ac-manifest.json)。
- TagFilter仍独立取全标签，VideoTagPanel仍取全manual计数，分页候选及共享快照仍待完成；不能称整页已不执行任何标签聚合。主基准新增两个selected-label用例，AA/AB历史探针25/27项仍是当时数量；AC没有重新运行新增用例后的27/29统计探针。无新迁移/生产索引、用户数据访问、提交、推送、发布，完整目标继续进行中。


## 后续批次 AD：手工标签候选按需分页与身份保护

- VideoTagPanel取消挂载时全量manual计数查询，打开弹窗才请求最多100项候选。服务端按名称排序，搜索沿用JavaScript Unicode小写及字面子串语义，250ms防抖；翻页只保留当前页，加载、空结果、失败重试均可见。排序由原计数顺序改为按名称，界面明确标注。
- 候选只返回ID和最多128个Unicode码点加省略号的显示名称，不聚合可见影片计数。选择已有标签按ID写入，保留完整原名；自由输入仍使用完整文本创建。写入受元数据锁保护并在事务中完成，失败时新标签创建或来源提升一并回滚。缺失/空白名称报错，绝不将截断名称当作身份。
- 弹窗绑定影片ID，旧查询和写入完成不能覆盖新影片状态。成功添加先关闭候选入口再重置搜索，避免无用刷新；失效候选失败后仅刷新读取，不自动重试写入。94项定向测试覆盖这些真实组件行为，以及分页、Unicode、长控制字符载荷、隐藏manual关联、统计前后查询和事务回滚。
- 全量npm test：2,143通过、1跳过、0失败。随后真实Chrome组件夹具发现长标签横向溢出，补充最大宽度与单行省略；最终CSS架构、控件检查和build通过。全量套件在最后CSS修改前运行，最终浏览器检查在修改后通过；没有把旧套件结果表述为最后CSS的回归证据。1000×640与1440×900均验证分页、搜索、错误重试、按ID选择与无横向溢出，候选区clientWidth/scrollWidth均396。使用真实组件/全局样式和模拟IPC，不是原生Electron整应用或完整键盘验收。规范/规格静态审查无具体阻断。
- 独立顺序运行两组300382影片、有统计完整基准，每组32项：密集manual全计数1,451.00ms，候选首屏0.0694ms/2,906B，搜索0.1545ms，offset900为0.3270ms；稀疏manual全计数222.86ms，候选首屏232.74ms/1,457B，搜索2.6194ms，offset900为232.28ms。后者只有少量合格候选，查完标签及关联后才能确定没有下一页。不是所有场景都更快。三次热样本中位数、本机合成库，不是p95、冷盘或Windows/HDD。
- 候选EXISTS明确使用既有tag_id索引，避免统计倾斜时选origin索引反复扫描；但按tag_id查找后仍需判断origin，稀疏manual依然有约233ms同步段。分页限制返回量，不限制SQL总工作量；深OFFSET、标签总量增长、名称搜索仍需覆盖索引完整矩阵及读查询隔离。没有新增生产索引或schema迁移，也没有根据密集样本宣布性能达标。
- [完整日志](large-library-results/implementation/batch-ad-full-tests.log)、[密集基准](large-library-results/implementation/batch-ad-options-300382.json)、[稀疏基准](large-library-results/implementation/batch-ad-options-sparse-300382.json)、[浏览器结果](large-library-results/implementation/batch-ad-picker-results.json)、[最小窗口截图](large-library-results/implementation/batch-ad-picker-1000x640.png)、[源快照与清单](large-library-results/implementation/batch-ad-manifest.json)已保存。navigation-before为修复前导航多发请求的失败证据，不能当作当前失败。
- 下一步优先保留稀疏manual退化作为索引/隔离验收用例，处理TagFilter的全量标签计数、候选分页和缓存失效；其他15工作包/42风险仍按完整计划推进。无用户库访问、提交、推送或发布；当前schema16来自Y，本批没有降级。


## 后续批次 AE：稀疏候选覆盖索引与全矩阵控制实验

- 在临时库将既有tag_id索引扩展为(tag_id,origin)，没有修改生产schema16。六组专用夹具（10k/300382 × 全manual/稀疏/倾斜）均比较完整返回值，最终每组34条记录，包括非空搜索和offset2页、空深页、统计前后与写入后验证。30万稀疏候选首屏212.843→0.274ms，净活跃页增加6.53MiB，三事务1k写入3.389→3.945ms。索引空间和写入仍有成本，非空浅页不能代替非空深页验收。
- 主基准新增同库索引探针；300382密集/稀疏各通过单库30项和重叠32项完整结果比较，每份124条记录。阶段间恢复原索引和ANALYZE后才写入重叠成员，避免把候选残留当作基线。主矩阵稀疏首屏242.313→0.264ms，重叠238.260→0.278ms。
- 密集legacy.release出现566.62→676.96ms，单独十样本仍有差异。最终A-B-A控制为单库460.38→573.55→638.50ms，重叠631.28→631.07→628.26ms；恢复原索引没有恢复初始速度，存在运行阶段影响，不能直接归因索引，也不能宣称零退化。原缓存/物理布局未恢复，确切环境因素与目标硬件验收仍待确认。聚焦模式与全矩阵在输出中区分；未知case已验证抛错，不允许零比较成功。
- [专题报告与下一步实现方案](large-library-tag-origin-evaluation.md)、[脚本和原始结果清单](large-library-results/implementation/batch-ae-manifest.json)已保存并核验SHA256；脚本静态复核无剩余阻断，EQP代表参数和A-B-A物理状态限制已写入报告。本批只改实验脚本/文档，没有重复执行生产全量套件，也没有将AD测试数冒充AE验收数。
- 后续正式索引需要迁移/失败回滚/写入与启动时延验收，实验全ANALYZE不能直接用作生产策略。TagFilter最小完整方案已审查：按名称选页、仅本页补全局可见计数，保留跨页ID选择和100上限，明确排序变化，补真实父弹层隐藏请求和旧响应保护。完整计划继续进行中；无用户库访问、提交、推送、发布。


## 后续批次 AF：正式V17标签覆盖索引迁移

- 新库schema和V16→V17迁移均将idx_video_tag_tag_id扩展为(tag_id,origin)，保留原索引名、tag_id首列合同和独立origin索引。迁移只DROP/CREATE索引，沿用外层DDL/版本事务，不执行全库ANALYZE。数据库结构异常会报错，不跳过迁移伪装升级。
- 新增三项V17回归先在旧实现上失败，再验证：全部业务表行快照不变、除目标索引外schema不变、新建与升级索引SQL一致、重复启动幂等、来源变更与级联删除；DROP和CREATE执行后分别注入异常，验证窄索引/版本16/全部数据/外键状态恢复并可重试。为内存合成库异常回滚，不是磁盘满或断电验收。
- 旧版本迁移测试的窄夹具补齐无关标签关系表/索引；V16跨版本测试明确排除预期变化的索引，V17专测核对该索引。没有在生产代码中容忍缺失关系表或跳过异常。44项迁移/标签定向通过；全量npm test2,146通过、1跳过、0失败；build成功。脚本和迁移静态复核无具体阻断，证据限制已保留。
- 新增JAVDEX_BENCH_MIGRATE_FROM=16，只允许独立完整模式。临时文件库先恢复旧索引和版本16，造数及ANALYZE后实际调用正式迁移。300382密集/稀疏各32项运行成功，首个startup.current_schema.firstMs为实际升级560.34/575.40ms；warmMedian为已升级重复入口251.98/254.23ms，包含原有foreign_key_check，不能当作建索引时间或固定启动成本。
- 单库矩阵运行于迁移后、尚未重新ANALYZE状态；候选首屏密集0.0535ms，稀疏0.2774ms，稀疏搜索0.1361ms、offset900空页0.2285ms。主脚本原有overlap阶段之后才ANALYZE，本模式只补两个overlap用例，不是AE的30/32索引差分探针。各结果为本机三次热样本中位数，不是p95或客户Windows/HDD。
- 测量结束关闭数据库，再以readonly重开，核对版本17、索引列、影片/关系数量及foreign_key_check/integrity_check。这里的关系数对比关闭前值，不是迁移前全部字段快照；全字段保留证据来自V17测试，完整查询等价证据来自AE同库索引实验，不能混称本次大库做了所有字段差分。
- 两个历史实验脚本显式恢复pre17窄索引后才造数/收集统计，防止正式schema变化后把覆盖索引误当旧基线。小规模专用及完整矩阵重新验证；相关源快照、测试、构建和原始JSON见[AF清单](large-library-results/implementation/batch-af-manifest.json)。
- 当前工作分支schema17；官方0.6.2仍是15，升级后的库不能直接由官方旧版本打开，本批不提供降级。未打开用户库、提交、推送或发布。正式索引已落地；启动检查/迁移让步、Windows/HDD、故障恢复和长期写入验收仍待完成。下一步推进TagFilter按名称分页及页内计数，完整15工作包/42风险目标继续进行中。


## 后续批次 AG：TagFilter分页与本页可见计数

- 新增tags.filterOptions类型化IPC/服务/Repo，按名称选至多100项并用额外一行判断下一页；同一读事务只统计实际返回ID的video_tag关联。EXISTS检查active/非隐藏成员，共享影片只计一次，保留全部origin、无关联及零计数标签。计数仍是全局口径，不随其他筛选或当前媒体库联动。
- TagFilter删除挂载时全量tags.list及本地200项截断，改为按需分页、250ms Unicode搜索防抖、单页快照、错误/重试与旧响应保护。按ID跨页选择，最多100项且可继续取消；选择本身不重查候选。默认模式内联名称独立走useTagLabels。排序从计数降序改为名称顺序，UI明确显示“按名称”，未把页内排序冒充全局计数排序。
- LibraryPage传给父弹层的open同时要求surfaceMode active且无详情覆盖，避免隐藏时挂载候选。真实父弹层开关/关闭后晚到响应已做组件测试；LibraryPage该路由条件目前仍是静态验证，不冒充整页路由端到端验收。
- DB测试比较206标签跨页、共享/归档/隐藏/混合来源和统计前后的旧计数oracle，验证Unicode字面搜索、截断显示名、空页零关联查询和参数边界。一万余无关标签/关联下，单个零关联搜索候选在无统计/ANALYZE后都按tag_id SEARCH，无SCAN vt；不是热门100项页成本保证。IPC同测manual/filter候选边界。
- React实际组件验证仅打开才查询、分页、跨页选择、选择不刷新、搜索归零及旧页丢弃、错误显式重试、100上限允许移除、真实父弹层卸载/重开。全量npm test2,152通过、1跳过、0失败，build成功；之后仅强化测试中的EQP/IPC断言，最终34项定向、类型检查和改动测试lint通过。静态审查无具体阻断。
- Chrome真实父弹层/全局样式、模拟IPC，1000×640与1440×900均通过100项分页、选择ID101、关闭重开后的错误重试、搜索和无横向溢出，候选clientWidth/scrollWidth均322。截图等待动画结束并滚到分页区后人工查看；小窗口主体可滚动，页码和底部完成按钮可达。这不是原生Electron或完整键盘旅程。
- 独立300382有统计主基准35项通过：全标签573.051ms/46,787B，候选首屏77.988ms/4,806B，搜索8.602ms/553B，offset900为78.371ms/4,809B。本机三次热样本中位数，不是p95/Windows/HDD/端到端延迟。热门页仍可能读取大量关联，搜索/深OFFSET仍受标签总量影响，返回有界不等于数据库总工作量有界。
- [日志、基准、截图与源快照清单](large-library-results/implementation/batch-ag-manifest.json)已保存；主脚本新增3项filter用例，当前完整probe会是33/35项，AG没有重跑新版统计/索引探针。schema17未变，无用户库访问、提交、推送或发布。TagFilter全量候选路径已移除；共享缓存/计数失效、读查询隔离及其余实体分页仍按完整计划推进。


## 后续批次 AH：标签筛选页的有界修订缓存

- TagQueryService.filterOptions增加最多8页、键和值合计512KiB UTF-8序列化留存预算的LRU；命中提升访问顺序，超页数或字节先淘汰最旧页。实际JS字符串、对象、临时结果和IPC缓冲不等于此预算，不宣称总堆/RSS已受512KiB约束。
- 共享normalizeTagOptionsQuery先验证原始参数再trim/Unicode小写规范化缓存键；传给Repo仍是原始query，避免500个İ折叠后超过500而被误拒绝。省略/显式默认值和等价大小写共享缓存，非法输入不会借规范化命中旧页。
- connection身份、total_changes、data_version及schema_version组成修订。任意本连接写入、外部提交、结构变化或换库都失效；无关表写入也保守失效，繁忙后台任务可能降低命中率。查询前后修订不同不回填；已有事务中完全绕过缓存读写，防止使用错误快照或发布未提交数据。
- 缓存存JSON，命中重新parse，调用方修改数组/对象不污染缓存。测试覆盖本地隐藏变化、外部提交、DDL、同库重开、两个计数完全相同但连接不同的库、事务回滚/提交、8页LRU、超长控制字符导致提前字节淘汰、原始参数超限和500İ。
- 外部连接在tag页已建立读快照后、计数SQL前提交隐藏变化，当前返回旧快照1，下一次返回0，第三次命中不重查；首次查询失败后同query可重试。该行为测试不直接观察内部是否存入缓存，“前后修订不同不回填”另有静态分支证据，不混称内部状态观测。
- 全量npm test2,156通过、1跳过、0失败，build成功；之后仅新增外部并发提交/失败重试/同计数换库三项测试，最终19项定向、node类型和测试lint通过。静态审查无具体阻断。[测试、构建、基准与源快照清单](large-library-results/implementation/batch-ah-manifest.json)已保存并校验SHA256。
- 独立300382有统计主基准37项：未缓存Repo首屏热中位78.055ms；服务首次缓存未命中79.633ms，后续命中0.03325ms；每次真实写入后重新读取78.384ms，均返回4,806B。命中计时包括修订PRAGMA和JSON解析，但sqlCalls只拦截prepare方法，不包含pragma调用，不能将sqlCalls=1解释成只执行一条数据库指令。
- 这是本机三次热样本，不是冷盘、p95、Windows/HDD或端到端UI时间。首次查询、频繁写入后的重算和热门页仍有原成本；本批只覆盖标签筛选页缓存，不代表全部计数缓存、跨worker请求合并或全局内存预算完成。主脚本新增2项缓存用例，当前probe会为35/37项；未重跑新版统计/索引探针。
- schema17未变，无用户库访问、提交、推送或发布。后续继续计数失效范围、读查询隔离及剩余实体分页；完整15工作包/42风险保持进行中。


## 后续批次 AI：只读连接与原生worker可行性

- 新增caller-owned openReadOnlyDatabaseAtPath：readonly、fileMustExist、query_only，要求user_version等于当前17且journal_mode为WAL；不创建目录/数据库、不迁移、不切换日志模式、不替换全局writer，失败关闭局部连接。注册与writer一致的Unicode标签搜索及演员名称归一化函数。版本标记校验不证明整个schema完好，不冒充完整结构/数据审计。
- writer初始化改为完成配置和迁移后才发布全局db；失败关闭局部连接，getDb仍未初始化，随后可正常重试。避免迁移失败后initDatabaseAtPath返回半初始化连接。原有pragma配置行为未改，未宣称失败writer初始化从未触碰数据库日志设置。
- 四项新测试覆盖独立连接/禁止DML、DDL和版本写入/SQL函数等价/不改变其他schema；WAL读事务期间writer提交、当前快照一致与下一次可见；读事务异常结束；缺失、旧版、新版及非WAL拒绝且不迁移；失败writer初始化后可重试。组合只读/修订/标签缓存12项通过；全量npm test2,163通过、1跳过、0失败，build成功。静态复核无具体阻断。
- 原生worker探针将实际readonly工厂打包进临时CJS，使用当前Electron Node环境和better-sqlite3查询合成库，并与主线程执行同一百万项递归求和SQL比较结果。worker查询71.57ms，主线程收到reading/done之间定时器运行11次；worker整体阶段最长定时器间隔6.29ms；主线程同步SQL71.64ms，最长间隔72.13ms。
- 上述ticks包含消息调度及reader.close尾部，不证明每个tick都在native SELECT内部；workerMaxTimerGap包含启动/加载/查询/终止等待。探针证明本机开发环境原生worker可用和主线程响应能力，不是实际大库目录延迟、p95、Windows/HDD或打包验收。reader先关闭再发done，异常/超时拒绝，finally终止worker、关闭writer并删除本次临时目录。
- [源快照、测试、构建与原始指标](large-library-results/implementation/batch-ai-manifest.json)已保存并校验。尚未将生产IPC移入worker；本批不声称主线程慢查询已解决。后续接入方案见[读查询隔离落地清单](large-library-read-worker-plan.md)。schema17未变，无用户库访问、提交、推送或发布；完整计划继续进行中。


## 后续批次 AJ：标签筛选生产worker与有界调度

- TAG_FILTER_OPTIONS正式进入独立只读worker，路径由应用内部取得，不接受调用方SQL或数据库路径。仓储与缓存工厂显式绑定连接，保留AH的8页/512KiB序列化预算、Unicode验证、快照、外部提交失效及对象隔离；其他标签/列表/首页/Web读路径没有迁移。
- 单worker串行，最多32个已接受订阅（合并请求也计数）；等价查询按参数与writer修订合并。换连接/换路径拒绝旧请求并等待旧worker退出才启动新的。启动、执行各15秒超时；失败明确拒绝，无自动重试或同步SQL回退。内部AbortSignal可移除排队订阅，已执行取消仅丢弃结果且保留执行槽。renderer IPC尚未传递AbortSignal，关闭弹层只是丢弃旧结果。
- 正常退出先停止准入，发送close释放SQLite，1秒后尝试原生terminate，确认结束才关闭writer。终止拒绝时完成其他清理后app.exit(1)，不伪装正常关闭。native terminate不是SQLite硬中断；若原生调用及终止一直pending，退出和替换仍可能等待，期间新排队请求尚无独立等待期限。此缺口未以文档说明冒充已解决。
- 正式electron-vite入口输出worker及共享chunk，直接声明测试/探针所用esbuild开发依赖。真实worker集成验证只读查询、写后缓存刷新、调用方/订阅对象隔离、版本不匹配拒绝且不迁移、初始化期间dispose。假transport验证容量、代次、合并、取消、超时和终止失败。最终45项定向全部通过。
- 全量npm test：2,184通过、1跳过、0失败；随后修正退出终止失败分支，最终Node类型、该文件lint、build与上述45项通过。全量套件早于最后退出分支修正，不将其冒充最后代码的完整回归。真实无窗口Electron成功加载合成ASAR里的构建worker、共享chunk和解包native SQLite，正常查询并退出；不是签名安装包、全应用启动、长查询退出或Windows验收。
- 独占顺序运行300,382影片/1,000标签/每片4关系的合成库：主线程未缓存Repo中位72.460ms、最长5ms定时器间隔78.123ms；worker首次读取142.847ms（含启动），缓存命中0.315ms；每次真实修改影片时间戳并提交后读取75.534ms、最长定时器间隔6.309ms。三次热样本、计时包含结果相等断言及失效阶段写入；不是IPC端到端、p95、冷盘或客户Windows/HDD。查询CPU成本仍在，隔离改善主循环响应。RSS阶段采样约127.3→154.0MiB，不能当作峰值或严格worker独占内存增量。
- [测试、构建、ASAR、实际worker基准与源快照清单](large-library-results/implementation/batch-aj-manifest.json)保留全部本批证据。初步无值变化UPDATE与并行类型检查时的诊断结果未作为最终基准。规范/规格最终静态审查记录另见清单。
- schema17未变，无用户库访问、提交、推送或发布。PERF-10只完成标签筛选这一条生产链路，完整15工作包/42风险目标继续进行中。


## 后续批次 AK：worker排队订阅等待期限

- 对每个订阅增加独立queueTimeoutMs（默认30秒），覆盖ready前、执行槽排队和旧worker退出屏障等待。进入执行时清除等待计时器；执行保持原15秒deadline。它不是总请求期限或原生SQLite硬终止期限。
- 超时明确拒绝并释放订阅容量；仅最后一个等待订阅退出时删除未执行flight。合并请求的后来订阅保留自己的期限，过期清理不影响同键新flight；不自动重试，不绕过旧worker终止屏障，不提前释放执行槽。取消/失败/dispose沿用统一清理。
- 三项虚拟时钟测试先在AJ实现上失败，再验证：旧native终止一直pending时32个调用均收到超时、恢复准入且不并发开新worker；合并订阅独立过期、进入执行后等待计时器已清除；ready前唯一订阅过期不会发送查询。队列与真实worker组合23项通过。两路静态审查无具体阻断。
- 最终全量npm test：2,187通过、1跳过、0失败；build成功，真实无窗口Electron加载最终ASAR worker/native SQLite并正常退出。随后独立30万基准：主线程Repo中位72.050ms、最长定时器间隔78.097ms；worker首次89.709ms，缓存命中0.262ms，真实提交后重算74.600ms、最长间隔6.535ms。三次热样本且含结果断言，不是p95/冷盘/Windows/HDD/完整IPC；本批未测峰值内存或原生长查询终止。
- [失败回归、最终日志、ASAR、基准、两路审查与源快照](large-library-results/implementation/batch-ak-manifest.json)已归档。前测17通过3失败是缺少等待期限的历史证据，前测失败清理曾产生异步拒绝；最终测试已捕获清理拒绝且全量通过。
- 原生终止永久pending时，排队调用者已有明确超时结果，dispose仍需底层实际结束；跨平台/长查询退出、IPC取消、其余读路径及完整计划继续进行中。schema17未变，无用户数据访问、提交、推送或发布。


## 后续批次 AL：待确认刮削概要分页与按需详情

- PendingCenter不再调用全量listPending：每页默认50项、API上限100，列表只收id/videoId/revision、显示番号、来源/候选数及首候选封面。完整候选仅选中一项后getPending；确认、导演选择与合并应用仍使用完整原始DTO/ID。旧list接口保留，MediaLibrarySettings审计链接状态仍调用它，不能称整个应用已无全量待确认读取。
- COUNT、锚点定位、分页及页内元数据在同一读事务。沿用created_at,id顺序，item或videoId定位所在页（互斥且safe integer），深页删除后回退最后有效页。代码显示最多128个Unicode码点加省略号，SQLite先按ECMAScript空白集trim；非法候选JSON回退空番号，封面路径超过4096个SQLite字符返回null。数据库原值不改。
- 一页固定准备5条语句（有锚点另加2条），不是只执行5条SQL：元数据计数、首候选及封面仍按本页各项执行。聚合候选总量、首候选JSON提取、排序/offset和锚点rank仍有数据相关成本；没有把返回有界说成SQL工作量恒定。
- URL统一LIST_PARAM.pendingScrapeOffset；页/详情query key分离，gcTime0释放未订阅快照。URL规范化完成才挂载详情，浏览器发现的重复详情已消除；概要页规范化仍会产生一次额外页查询。失活时使用独立count，count失败显示未知而不阻断其他分类；active页以事务内total为准。完整IPC取消尚未接入，晚到结果由查询身份隔离，不宣称底层任务已取消。
- 测试覆盖1万待确认项、候选含1MB简介但首50项JSON小于16KiB、Unicode/空来源/非法JSON、两种深链接、跨页顺序、越界删除、参数边界。显示路径的最坏长度会使载荷大于此普通夹具的16KiB，不宣称统一16KiB页预算。真实React页面验证深链接110、翻页到51、旧详情与旧页面迟到、最后101删除回退51、读取失败重试及停用页总数120→7。count失败用例验证空扫描队列仍正常显示，不冒充非空扫描确认旅程。
- 原有导演选择→合并→应用交互测试已迁移到新page/get夹具并保留业务断言。最终68项定向通过；全量npm test2,194通过、1跳过、0失败；build成功。两路静态审查指出的跨分类错误/陈旧计数P2及URL常量P3已修正并复核。
- 所有全量/构建任务结束后独立运行已ANALYZE的1万条、每条1来源/1候选/4KiB简介基准：旧全量hydration中位502.503ms/46,503,365B，概要首50项1.585ms/6,350B，定位第9876项所在页1.808ms/6,789B，单项完整详情0.05483ms/4,650B。三次本机热样本，只计Repo调用，不含JSON序列化或断言，不是IPC端到端/p95/Windows/HDD。首屏有完整50项等值断言，深页仅验证offset和目标成员，详情仅验证身份/简介长度，不代表全部字段差分；多来源/多候选性能分布尚未测量。旧全量先跑，RSS阶段采样约1.41GB包含其残留，不能据此声称新路径峰值或独立内存开销。
- [最终日志、浏览器截图、原始基准、审查与源快照清单](large-library-results/implementation/batch-al-manifest.json)保存本批证据；测试夹具变更前的失败不当作当前失败，也未改用户数据。
- Chrome实际页面/路由/全局样式配模拟IPC，1000×640和1440×900均验证50/20行分页、重试、长标签无横向溢出、页眉保留与分页按钮可达；详情调用精确为[1,51,101]。截图使用固定高列表容器，并滚动队列到底部；不是原生Electron整应用或全部键盘/多设备验收。
- schema17未变，无用户数据访问、提交、推送或发布。扫描/演员队列全量、设置页旁路、变更事件、查询后台化和其他15工作包/42风险继续推进。


## 后续批次 AM：审计待办存在性与有界显示

- MediaLibrarySettings删除完整待确认刮削查询及向下传递的全量ID集合。审计改为每页最多100项，存在性API只接受当前页最多100个安全正整数，按pending_video_scrapes主键查存在ID，不解析候选、请求或附件JSON；空请求零数据库工作。当前生产renderer已无scrape.listPending调用，旧内部接口仍保留，不能称所有潜在调用入口均已移除。
- 仅有当前页中刮削待办目标才查询；保存单个结果快照，查询scope涵盖媒体库、扫描run/完成时间、tab和筛选。返回相同页仍使用新请求identity，防止A已ready→B未完成→返回A时恢复旧按钮；晚到回复不能覆盖新页。未知/失败不标记“已处理”，查询失败有显式重试。已有IPC未真正取消，快速翻页的在途调用总数未由此hook施加全局限制。
- 所有审计tab增加100项本地页边界，原虚拟列表继续用于当前页。全部文件→异常待办先定位所在页再scroll/focus，保留历史计数/首条去重语义。未识别文件原来两次filter内findIndex造成平方遍历，现一次Set去重并复用，保留同一路径首条记录。
- 这不是后端审计文件分页：原始audit.files/未识别数组仍全量载入，构建筛选项仍与全集有关；设置页扫描分组/资源身份详情仍全量查询。页面计数未以当前100条冒充总数，未知存在性不用于改写历史审计数量。事件刷新、后端流式审计/概要及更多队列仍未完成。
- 测试覆盖1万待确认中只读ID查询/重复和缺失/上限，hook空请求、错误重试、换run、迟到页及A→B→A；真实审计组件201项分为100/100/1且每页仅查询对应ID。Chrome实际组件/样式、模拟IPC，1000×640与1440×900验证错误不提供待办操作、重试恢复、打开201、全部→异常定位第3页、document.activeElement确为201行且完整位于视口、无横向溢出。未作为原生Electron整设置页或完整键盘旅程验收。
- 最终12项hook/组件定向通过，全量npm test2,199通过、1跳过、0失败，build成功。Standards无具体阻断；Spec指出的ABA P2已修正并复核。最终浏览器在该修复后执行，额外验证真实activeElement与视口位置。
- 全量与构建结束后独立重跑1万待确认/1来源/1候选/4KiB简介、已ANALYZE夹具：100ID存在性中位0.034167ms/502B，旧全量484.558ms/46,503,365B；首50概要1.400ms/6,350B、深页1.725ms/6,789B、单详情0.05358ms/4,650B。三次本机热Repo计时，不含序列化/断言，非p95/IPC端到端/Windows/HDD。存在性完整结果与100个预期ID一致；RSS继承旧全量阶段，不能归因当前页开销。
- [最终日志、基准、截图、审查与源快照](large-library-results/implementation/batch-am-manifest.json)已归档并核验。主pending基准新增第5项existing.ids100，AL历史4项结果保持不变。schema17未变，无用户数据访问、提交、推送或发布；完整15工作包/42风险继续推进。


## 后续批次 AN：统一三类审计待办存在性

- 设置页移除扫描分组、资源身份的全量详情查询与prop链。审计当前页统一发送PendingAuditIds，三数组合计最多100个安全正整数（不是每类100）；单事务先核对媒体库存在，再按需查询三类ID。group/identity使用library_id限定，scrape沿用全局ID语义；同数值的不同种类ID保持独立，不读取路径、资源列表或JSON。
- 新usePendingAuditPresence继承单快照、请求identity、ABA与迟到响应保护，key包含libraryId与扫描/筛选scope；三类状态均在查询成功后决定待办按钮。空页/无目标不发IPC；Repo直接空请求仍核对媒体库存在。原始审计和收件箱的扫描/演员队列没有因此分页，也没有全局限制快速翻页的在途请求。
- 将历史定位标识与操作资格分离：groupId不再随loading/error/gone清除，待办动作仍受新查询结果控制。审查指出的慢响应焦点P2已修复；gone组保持稳定锚点但无操作按钮。浏览器主动暂停presence Promise到RAF之后，验证实际activeElement为group:201、界面仍读取中且无待办按钮；放行后才打开scan201。finalAnchor只记录最后的行标识，不伪称点击后的实际焦点。
- 1万扫描组+1万身份、两个媒体库夹具验证同输入的跨库隔离、全局scrape、删除和未知ID、4条ID-only查询及总上限。真实组件验证三类型混合页一次请求、分别打开identity-7/scrape8/group9；原ABA/错误/分页测试沿用新hook。Chrome1000×640/1440×900均验证刮削与组延迟两类旅程；只是组件/样式与模拟IPC，不是原生整设置页、全部键盘或目标硬件验收。
- 最终19项定向通过，全量npm test2,203通过、1跳过、0失败；build成功。两尺寸刮削和group-delayed共4组浏览器检查通过；两路审查完成，焦点P2已关闭。[日志、基准、截图、审查与源快照清单](large-library-results/implementation/batch-an-manifest.json)已核验。
- 扩展合成夹具为1万刮削待确认、1万扫描组及1万身份，已ANALYZE；三类混合100ID（34组/33身份/33刮削）Repo热中位0.109458ms、547B JSON等价值，完整返回与输入期望相等。三次本机顺序样本，不含序列化/断言，非IPC端到端/p95/Windows/HDD。当前脚本6项且新增了2万扫描实体，不能与AL4项/AM5项的较小夹具直接比较或归因速度变化；RSS继承旧full展开阶段，不代表此查询峰值。
- schema17未变，无用户数据访问、提交、推送或发布；完整15工作包/42风险仍未完成。


## 后续批次 AO：扫描收件箱概要分页与单项详情

- PendingCenter不再逐库读取全部扫描分组资源和全部身份详情。统一活动库范围的扫描概要查询，每页默认50、服务端最多100；按旧规则先groups后identities，两类各自按library position/id、updated_at/id排序。在同一读事务内计数、定位anchor和取页，仅为本页查询资源数/短显示名。未知或归档库范围返回0项；详情API仍验证库存在并按库+ID定位。
- 新概要只含id/libraryId/revision、种类、短标题及资源数或文件名，不传资源数组、完整路径或目标地址。标题单段最多128个Unicode码点加省略号；身份标题的两段各受限。详情保留完整业务数据与修订号，身份确认继续使用expectedRevision并由用户明确选择。无schema变更（仍17），无演员名称规则修改。
- URL新增统一scanOffset；scan:id与scan:identity-id在活动库范围定位，末页删除后回退。概要与选中详情按query身份隔离，未订阅页gcTime0。URL规范化完成后才读取详情，inactive扫描分类只查count；库列表或count失败不阻断其他分类。库列表失败回归验证刮削空态，非非空刮削业务全流程。旧详情/旧库页迟到、详情拒绝重试/缺失、媒体库作用域和identity深链均有测试；既有身份选择确认、导演选择→合并→应用流程继续通过。
- 最终59项定向通过；npm test2,212通过、1跳过、0失败（2,213项），build成功。Standards指出的错误URL参数测试与Spec指出的跨分类错误隔离P2均已修正并静态复核。Chrome实际页面/路由/样式配合模拟IPC在1000×640、1440×900验证50/50/20分页、错误重试、无水平溢出、页眉和分页可达及详情调用[1,51,101]；这不是原生窗口或完整扫描写入E2E。截图位于滚动到页尾状态。
- 独立合成库为1万扫描组、每组2资源、每资源4KiB显示名，加1万身份冲突；ANALYZE后3次本机热样本。旧全量Repo中位88.197458ms/90,097,861B JSON等价载荷；首50概要2.190875ms/4,468B，身份9876深页4.975083ms/5,790B，count0.6895ms/5B，单组详情0.051708ms/8,775B。首概要和深身份页有完整预期DTO等值断言。计时不含序列化/断言；非p95/Windows/HDD/IPC往返，旧全量先测，不据此推断独立内存峰值。
- 返回量/DOM有界不等于SQL恒定：COUNT、UNION排序、anchor排名、深OFFSET仍随队列规模增长，当前仍同步在主进程。选中单组仍全量加载该组资源；演员冲突队列、原始扫描审计仍未后端分页。没有全局IPC取消/并发背压，URL规范化仍会额外查一次概要页。这些继续保留在02/05/08/10/12中。
- [日志、基准、截图、审查和累计源快照清单](large-library-results/implementation/batch-ao-manifest.json)。未访问用户数据、提交、推送或发布。按新授权加入计划执行调整规则；暂缓方案须有证据和最终用户确认，当前未取消任何未关闭风险。完整15工作包/42风险仍未完成。


## 后续批次 AP：按分类读取演员冲突详情

- PendingCenter仅在all/actress分类且无详情覆盖层时启用完整演员冲突列表查询；scan/scrape分类使用已有summary展示数量。summary失败显示未知，不阻断扫描。禁用读取保留已经加载的groups快照及审核决定，未实施缓存驱逐或演员概要分页；用户已发起的异步变更完成后显式refetch仍可能读取停用分类，此处未声称全局请求取消。
- 确认并修正文档中的计数边界：getConflictReviewSummary仍调用ensureCurrentPendingConflicts，全量读取pending result_json并逐条检查，必要时补写冲突和递增revision。AP只消除无关分类重复的完整DTO/资源投影和字段变更计划，不能宣称此摘要恒定工作量或JSON-free。只读worker推广前先分离一致性维护，不能直接删除维护调用；见[读隔离依赖](large-library-read-worker-plan.md)。
- 真实页面测试验证scan期间完整actor读取为0、summary17→3、切入actress读取一次、切出后常规refetch不重读、summary失败仍展示扫描队列。最终真实hook回归选定非默认owner后禁用/恢复读取，owner与组选择保留。19项定向通过；全量2,214通过、1跳过、0失败，build成功。最后追加的审核决定保留测试在全量之后定向执行，不计入该全量数字；该测试与hook另行lint。
- 没有宣称新的耗时或内存收益数字：本批证据是请求次数和状态行为。演员完整队列、摘要修复扫描、缓存总预算与目标硬件矩阵继续保留。无用户数据访问、schema修改、提交/推送或发布；完整15/42计划仍进行中。

- 两路只读审查完成，停用时清空决定的风险已修正并补真实hook回归；[日志、审查与累计源快照清单](large-library-results/implementation/batch-ap-manifest.json)已核验。


## 后续批次 AQ：复用无写入的演员冲突一致性检查

- ensureCurrentPendingConflicts增加一个检查完成标记，绑定连接身份、total_changes、data_version、schema_version；只在调用方事务外、检查前后全部相同且没有写入时发布。未变化时省去重复全量pending JSON扫描；不缓存演员DTO或summary结果。任意本连接写入、外部提交、结构变化、重开连接均失效，失败不发布；调用方事务内总执行、不发布。
- 最关键的语义约束：本遍新增后访问候选的冲突，可能让先访问候选下一遍也产生冲突。因此修复有写入时绝不标记可复用，保留原先多次调用逐步补全语义，不宣称一次调用计算所有连锁修复。专门回归首遍只有target冲突、次遍补owner；另覆盖外部提交发生在检查中、修复后回滚、失败重试、重开同库及成功修复后再做无写入遍。
- 同步检查仍可能写数据库。任意写入后的首读、大量持续写入和连锁修复仍可能重扫；summary自身的分组/status聚合也仍遍历冲突关系。本批不能替代演员分页、维护/只读分离、worker或长期并发验收。
- 已ANALYZE的独立合成库：1万pending、每个result带4KiB文字、1万不同名称冲突且维护记录一致。每阶段3次顺序热样本，以无关probe表真实UPDATE在计时前使版本失效，演员业务行不变；失效检查中位262.155167ms、未变化复用6.029ms、再次失效255.312583ms。三阶段全部summary字段等值，载荷均130B。比较同一实现的miss/hit，不是旧构建对照；不含probe写入、JSON尺寸统计/断言，不是p95/冷盘/Windows/HDD/IPC端到端。未变化仍有聚合成本。
- 验收纠正：核对计数发现AP新增useConflictReviewController.test.tsx时覆盖了HEAD中两项既有测试。AP全量日志早于该覆盖，不能据此证明其最终测试快照覆盖完整。AQ恢复原文件两项测试原文，仅追加保留选择的回归（相对HEAD为27行增加、零删除）。恢复后的领域+hook定向64项通过；历史AP证据不改写，最终覆盖以本批恢复后日志为准。

- 最终恢复后的npm test为2,220通过、1跳过、0失败（2,221项），含原有两项hook测试和新增保留决定测试；build成功（生产代码未再改变，测试恢复在构建之后）。两路只读审查复核完成；[最终日志、基准、审查、完整恢复测试文件及源快照](large-library-results/implementation/batch-aq-manifest.json)已核验。未访问用户数据库、修改schema、提交、推送或发布；完整15/42计划仍进行中。


## 后续批次 AR：演员冲突概要页与单组读取接口（页面待接入）

- 新pageConflictQueue经typed IPC/preload提供默认50、最多100的概要页；getConflictGroup按完整normalizedName读取单组。旧list保留调用契约，新增内部onlyName只加载相关候选的完整JSON、全部冲突和资源，并在字段规划/合并预检前过滤目标组；单个大组及其mergePairs仍可很大。
- 概要保留历史claims先建组、active候选先加入、无active候选按首条历史冲突归组，再用完整displayName按zh-Hans-CN稳定排序。分页/anchor后才将显示标题截到128个Unicode码点+省略号；保留完整normalizedName作身份。返回候选数、历史claim数、status与首候选头像，不返回候选JSON/资源/mergePairs。头像超过4096字符省略；normalizedName未截断，因此条数上限不代表固定字节预算。
- 概要在完成必要一致性维护后用同一DB事务读取claims/冲突元数据。ACTIVE predicate与既有summary共用；元数据仍全量分组、排序，冷读维护仍可能扫描JSON并写入。不能放入只读worker，也未宣称O(页大小)SQL工作量。GET沿用既有详细工作流和修订检查语义，非跨调用一致快照。
- 混合fixture覆盖历史归属、共享名字、多候选/多冲突、可直接应用候选；概要页与旧full列表投影完全等值，get与完整旧组（含avatar/gallery资源、字段预览、mergePairs）等值。另有1万历史claim页上限与热路径不读取JSON/resources、完整Unicode名称排序后截断、legacy相同显示名跨页稳定、缺失anchor/非空越界/删除全部回退、无关非法warnings JSON不影响指定组等测试。最后84项定向通过；最终全量结果和独立基准另见下方。
- 当前只是后端/协议准备，PendingCenter演员页尚调用旧完整列表，不能把本批基准当作用户界面已实现的收益。下一步需拆分controller的队列概要与选中详情，并处理确认后的页定位/焦点、返回与未提交决定；完整演员队列分页验收尚未完成。

- 本批偏斜基准先尝试1,000组、同一归属演员持有1,000别名；整个运行器180秒超时且旧脚本无阶段日志，无法将该时限归因某条查询。[原脚本和失败日志](large-library-results/implementation/batch-ar-benchmark-1000-timeout.log)保留，不伪造成功数据。确认进程终止后将同分布规模降到100组，并增加阶段日志完成对照：关闭字段预览的旧全量中位189.053792ms/521,222B；首50概要0.409833ms/7,326B；anchor76所在末页0.306541ms/7,327B；单组完整get2.135083ms/5,316B。每组4KiB JSON文本，已ANALYZE、维护预热、每阶段3热样本；原oracle保留内存，因此不作峰值/独占内存推断。新get与默认完整旧列表中的组等值，元数据页与旧投影全字段顺序等值。
- 上述100组对照不替代1,000组或30万库目标；它使用同一归属演员100别名，非普通均匀数据。旧全量对照禁用了字段预览但仍做mergePairs预检，低估默认完整列表成本。超时路径的阶段诊断、单组预检成本、最终UI迁移及目标平台仍待完成。

- 最终npm test为2,225通过、1跳过、0失败（2,226项），包含后补资源/稳定顺序/回退测试；build成功（之后只有测试/基准/文档改变）。两路审查完成，84项定向通过；[日志、成功/超时基准、审查及源快照清单](large-library-results/implementation/batch-ar-manifest.json)已核验。无用户数据库访问、schema修改、提交、推送或发布；15/42完整计划保持进行中。


## 后续批次 AS：演员待确认页面按需读取与异步决定隔离

- PendingCenter 接入 AR 概要页，每页50项，只对规范化 URL 的当前名称加载完整详情。分页保留 `actressOffset`，深链定位后的真实偏移写回 URL；全部视图的 `queue` 指定翻页领域，避免选回排在前面的扫描队列。删除末页最后一项回退到有效页；删除深链项保留该页。失效页与详情分别报错并提供重试。
- 原 controller 决定流程保留，paged 模式禁用完整演员列表；overlay 保留一个选中组及未提交决定，切换组后的晚到详情不覆盖当前组。会话采用对象身份隔离 A→B→A，旧 resolve/discard 只释放忙碌状态，不清理新决定或新确认框；单独的丢弃弹窗身份避免旧完成回调关闭新弹窗。过期决定即使返回结构相同的数据也重新初始化选择。
- 名称修改仍调用服务端检查全库冲突，不把当前概要页当完整名称集合。确认后等待实际页及 URL 就绪恢复丢失焦点，已有控件焦点应保留。新增真实 Page/controller/router 交互回归覆盖翻页、深链、类别/overlay、错误重试、旧详情、跨组与 ABA 决定、丢弃弹窗、页外名称检查和 stale 状态。
- 最终81项定向通过，全量2,237通过、1跳过、0失败（2,238项）；build与最终受影响文件eslint成功。全量启动后补了最后一处body焦点guard，全量运行时测试已在该改动之后执行，另以最终源码重跑定向、构建和浏览器。原controller测试保留（相对HEAD新增27行、删除0行）。两路静态复核无剩余阻断。
- 三类队列真实Page/router/styles浏览器fixture在1000×640、1440×900均通过。演员覆盖overlay返回、删除末项焦点回退、概要/详情分别重试，以及held stale响应后保留“上一页”按钮焦点；无横向溢出、分页控件可见、无pageerror。已查看演员两种尺寸截图。曾复现的BODY丢焦日志与最终结果一起保存在[本批证据清单](large-library-results/implementation/batch-as-manifest.json)，13份artifact的SHA256已核验。
- 前端查询分页不改变 AR 的全量元数据排序/冷维护成本，单组详情与合并组合仍无界；未验证真实 Electron IPC 性能、Windows/HDD 或长期并发。下一步仍需定位AR的1,000组偏斜超时阶段，以及原始审计后端分页、刷新事件化和完整计划其他未完成工作。完整15/42计划保持进行中。


## 后续批次 AT：演员合并预检的名称重复归一化

- 分段探针将 AR 的千组偏斜慢路径定位到合并预检：千组共同归属演员持有千个别名时，原 `mergedNameConflictWithThirdPending` 对每条第三方冲突执行关联 EXISTS，并重复归一化双方名称。单组读取也受到影响。初次分段记录初始化7.27ms、冷维护32.13ms、概要页5.80ms、单组167.63ms；无字段规划的全量阶段观察到运行超过34秒仍未完成，随后主动TERM结束。该次是主动终止，不能当作完成耗时或新的180秒超时。
- 改为将双方归一化名称 DISTINCT 物化一次，再与冲突名称匹配；保留当前pending和双方排除、DISTINCT/排序、后续active判定及阻断提示。没有增加schema或持久缓存。通过实际workflow→get→mergePairs的100名称回归，原SQL执行5,549次归一化而失败，新实现满足不超过500次的上限并仍阻断第三方冲突。该测试只证明夹具的工作上限，不代表整个详情线性或严格每名称调用一次。
- 同库、同public get通过探针回放旧SQL，最终完整对象deepEqual；回放断言实际命中旧SQL，finally恢复prepare。新旧固定顺序单样本不能作为稳定加速比。原AR保存的千组脚本逐字节复制重跑并通过，整轮约11.8秒；三热样本中位数：使用新SQL的旧全量API（无字段预览）2,267.37ms/5,226,932B、首50概要1.139ms/7,423B、anchor876页1.080ms/7,425B、完整单组2.640ms/5,332B。预热且ANALYZE；计时不含序列化/断言，oracle保留内存，不作峰值或p95推断。
- 最终全量2,238通过、1跳过、0失败（2,239项），66项工作流定向通过，build成功。最终差分探针确认旧SQL实际命中1次，完整对象等值；固定先新后旧的单样本分别4.006/151.784ms。两路静态审查未发现剩余阻断。[本批源快照、红绿回归、主动终止记录、最终差分、原脚本重跑及全量/构建证据](large-library-results/implementation/batch-at-manifest.json)共11份artifact的SHA256已核验。
- 物化名称和匹配冲突仍随数据量增长；多个演员的单组组合预检、冷维护、目标硬件、原始审计分页和其他工作包仍未完成。本批解决的是已复现的偏斜查询重复工作，不关闭整个演员性能风险。15/42完整目标保持进行中。


## 后续批次 AU：演员身份候选的窄分页接口（弹窗待接入）

- 新 `listActressPickerPage` 经 QueryService、typed IPC 与 preload `actresses.pickerPage` 提供默认40、最多100项的 `items/hasMore/offset`；以limit+1判断后续页，不计算总数或作品/写真统计。按完整main_name、id排序，包含所有性别/刮削状态；有搜索时复用现有owned-name归一化及字面通配符转义规则。候选按名称排序是专用接口的明确合同，旧列表video_count排序不变。
- 每项只含id、显示名称和头像。SQL只读名称前516原始字节，JS保留前128个Unicode码点+省略号；完整名称仍用于SQL排序。头像先限制原始4096字节，再限制JSON编码4096字节，超限省略为null。名称只作显示，编辑必须按ID取完整详情。搜索输入最多256 UTF-16单元，offset为非负安全整数，越界返回空页并保留请求偏移。
- 审查发现并修复SQLite文本length遇NUL提前结束的上限漏洞：600,002字符NUL名称原实现回归失败，现按原始字节前缀安全处理。包含emoji、完整名称截断后同名排序、全性别/owned alias/转义搜索、10,000演员窄字段与无统计SQL、请求边界，以及100项控制字符名称和反斜杠头像的最坏JSON转义场景；后者整页低于512KiB。
- 10,000演员、每条4KiB简介、无影片关系或写真、ANALYZE后3热样本：旧全列表中位111.508ms/45,328,895B；首40候选0.0567ms/2,228B；末40候选0.1215ms/2,322B；名称搜索4.051ms/2,305B。夹具作品数全部为零，因此旧/新排序恰好一致；不能外推真实作品扇出场景、p95、冷盘、IPC或UI。oracle保留内存，不作峰值判断，计时不含断言/JSON编码。
- 最终全量2,245通过、1跳过、0失败（2,246项），build成功；定向30项通过之后补的最坏JSON用例已由最终全量覆盖。两路静态审查的NUL阻断已闭合；[源快照、红绿回归、基准及全量/构建清单](large-library-results/implementation/batch-au-manifest.json)8份artifact的SHA256已核验。当前“选择其他演员”弹窗仍用旧全量接口，下一批需要接入分页、过期请求隔离、选中保持/错误重试及实际浏览器验收。本批不关闭候选UI风险，搜索及深OFFSET也未变成常量工作。15/42完整目标保持进行中。


## 后续批次 AV：演员身份候选弹窗分页与窄身份确认

- “选择其他演员”实际接入AU pickerPage，每页40条；搜索回到第一页，原始输入变化立即清空旧页并隔离旧返回，再等待debounce发起新查询。页内过滤当前组已有owner，保留服务端hasMore供继续翻页；选择独立于候选页保存，不把离页选中项插入当前页。候选显示去掉作品数，采用名称排序，不再调用旧全演员列表。
- 为避免点击候选时又走完整演员详情、加载大量作品，新增pickerGet窄身份接口：按ID仅取当前revision和与AU同样有界的名称/头像，经repository/service/typedIPC/preload接入。提交名称归属只使用ID/revision，名称仅作显示。编辑仍需完整详情。候选已选头像目前保留列表快照，未宣称选择时头像同步刷新。
- 选择读取使用独立请求gate及group/open/search/offset/enabled会话对象；关闭重开、A→B→A、快速连续选择、离页/卸载后旧结果不改写决定。直接owner命令和提交决定也使旧选择失效。直接owner交错回归是在实际Page的绑定VM命令层复现，不声称已证明用户能从checked radio再次触发同一事件；浏览器单独证明关闭重开后的旧返回隔离。
- 候选读取失败显式重试，读当前身份时有忙碌提示，错误保留当前决定。分页/重试采用现有Button sm；列表独立滚动、分页区不收缩。真实Page/router/styles浏览器fixture在1000×640与1440×900通过40→40→21分页、搜索回到0、失败重试、离页选中保持、关闭重开后旧选择返回；DOM仅当前40项、无横向溢出、分页位于视口内，pageerror为空。fixture禁止旧全列表和完整get调用。已查看两种尺寸最终截图，图与日志见本批清单。
- 59项定向通过（含窄identity大profile不投影、revision更新/NUL/缺失/边界；以及controller/Page交互），之后仅将内部remote方法改名，最终全量2,254通过、1跳过、0失败（2,255项），build成功。两路静态复核无剩余已知阻断；[源快照、红绿交互、浏览器截图/结果和全量/构建清单](large-library-results/implementation/batch-av-manifest.json)10份artifact的SHA256已核验。前端不累积历史候选页，但未提供全局IPC取消/并发预算；搜索、深OFFSET、单个冲突组内部复杂度及其余候选/实体仍待处理。完整15/42目标保持进行中。


## 后续批次 AW：合并演员候选的兼容过滤与本页计数（弹窗待接入）

- 新 `listActressMergeCandidates` 经QueryService/typedIPC/preload提供默认40、最多100的候选页。事务内按keepId读取实际性别，排除自己，保持原规则：male单独一组，未知/null归入female；复用owned-name搜索，按完整main_name/id排序，显示名称/头像复用AU/AV的字节及NUL边界。不把客户端传入的性别当过滤依据。
- 先取limit+1，仅对实际返回页的ID计算可见影片数，不计lookahead；空页跳过计数。video_actress主键保证单演员/影片唯一，成员EXISTS只认active库内未隐藏成员，跨库共享不重计、仅隐藏/归档/无成员的影片不计。keep、候选和计数在同一读事务内，外部WAL写入的回归证明本次使用原快照，下一次看到新状态。
- 定向34项通过，覆盖原list+canMerge的筛选/名称搜索oracle、跨库计数、页ID参数和空页、外部WAL快照、NUL长名称与边界、typedIPC校验。页ID测试仅证明计数参数范围；实际索引访问另由偏斜基准的参数化EQP验证。
- 独立合成基准：10,000演员、4KiB简介、100,000影片/演员关联、150,000成员（50,000跨库重叠）、6,666可合并候选。ANALYZE/预热后3样本中位：旧全列表175.535ms/45,328,421B；首40候选0.315ms/3,608B；末26候选9.878ms/2,422B。oracle按实际兼容规则筛选、显式改按名称排序后，候选所有字段与计数等值；名称排序是新候选接口合同，旧列表按video_count排序的合同不变。
- 偏斜阶段再给末页候选9998增加200,000部作品（总300,000影片/关联、350,000成员）并ANALYZE：首页0.324ms，包含该候选的末页75.347ms。参数化EQP仍使用actress_id索引查va，再按video_id索引验证可见成员。这说明本夹具页外热门演员没有放大首页计数，同时明确展示页内热门演员成本仍随作品量增长；不作全查询O(页大小)、p95/冷盘/Windows/HDD/IPC/UI或峰值内存推断。
- 最终全量2,260通过、1跳过、0失败（2,261项），build成功。两个静态审查无已知阻断；[源快照、定向/全量/构建、普通及偏斜基准/EQP清单](large-library-results/implementation/batch-aw-manifest.json)7份artifact的SHA256已核验。MergeActressModal仍调用旧全量列表；下一批要接入此接口并验收翻页、选择/合并方案保持及错误处理，本批不关闭合并候选UI风险。完整15/42目标保持进行中。


## 后续批次 AX：合并演员弹窗分页、会话隔离与错误可见性

- 实际 MergeActressModal 接入 AW mergeCandidates，每页40条，以hasMore继续翻页；不再读取完整演员列表。搜索回到0，原始输入改变时立即隔离旧结果，再等待300ms debounce。选中演员及主名合并方案独立于当前页保留；主动换选演员才重置方案。显示名称可截断，合并仍只传keepId、mergeId与mainNameFrom，服务端按ID读取真实名称。
- 读取错误与合并错误独立，分页失败可重试且保留选择/方案/合并错误。以keepId及性别隔离会话，旧页返回和旧合并完成不影响新会话；在途ref阻止同一事件周期重复提交。合并中禁用搜索、候选、分页、主名选择和取消，Modal禁止Escape关闭；服务端原合并语义不变。
- 初次浏览器脚本直接check隐藏radio被可见label拦截，该自动化失败不能归因布局。独立截图确实发现1000×640候选列表与方案重叠，已将body改为稳定纵向滚动、预览不收缩、候选区保留280px。短窗口可滚动访问完整内容，底部操作固定；不宣称所有内容同时可见。合并失败后自动滚动到错误提示，未调用focus；尚未动态断言错误出现时activeElement保持。
- 最终真实组件/styles、合成API浏览器在1000×640及1440×900均通过：40→40→21、搜索回0、分页失败/重试、离页选择和方案保持、合并失败/重试、忙碌控制和Escape保护。几何断言覆盖预览/候选/方案互不重叠、分页滚动后可达、完整错误位于固定提交按钮上方；无横向溢出或pageerror，两种最终截图已查看。六项交互测试另覆盖旧查询、保留演员变更、旧合并回调、同周期重复提交及合并失败后翻页失败/重试的交错。
- 最终npm test为2,266通过、1跳过、0失败（2,267项），包含最后修正的fixture排除keepId；两路静态复核无剩余阻断。构建结果及证据清单在本节收尾记录。原controller测试仍保持相对HEAD新增27行、删除0行。
- 本批只证明当前弹窗请求/DOM与状态行为，不新增真实IPC耗时、峰值内存、p95、冷盘或Windows/HDD结论；AW页内热门演员计数成本仍存在。后续确认插件测试演员选择器仍全量读取后截80项，且以完整主名提交测试目标，不能直接用截断显示名替换；批量头像构图的计数/目标枚举也仍全量加载演员资料，需分别改造。原始审计分页、实体详情、扫描流式化及其他工作包仍保留，完整15/42目标继续进行。

- 最终build成功；[本批日志、浏览器结果/截图、静态审查和累计源码快照清单](large-library-results/implementation/batch-ax-manifest.json)共10份artifact的SHA256已核验。未访问用户数据库/媒体、修改schema、提交、推送或发布。


## 后续批次 AY：批量头像构图的专用计数

- 设置页经实际 AvatarAutoCropBatchProvider.countAllAvatars 调用专用countAvatarCropTargets，经preload/typedIPC/QueryService进入单条COUNT。不再为数量读取全部演员宽资料、作品/写真统计与排序，不枚举头像文件。返回数字，不在前端构造目标数组。
- 保留原全性别Boolean(avatar_source_path || avatar_path)条件：任意路径非空即计入，空格及NUL也保留；SQL采用BLOB长度避免SQLite文本length遇NUL为0。不把计数改成“文件存在/可解码”的数量。75种gender×source×display组合与旧完整list过滤结果等值，另检查只准备COUNT且没有作品/写真/profile/order读取，删除后计数为0。
- 实际Provider测试禁止legacy list，验证300382→0、失败传播、任务状态仍idle及订阅清理；300382为mock返回值，不是30万库耗时或内存基准。临时恢复旧Provider实现运行同一测试，明确因Full target list forbidden for counting失败，随后finally恢复最终源码。服务层委托与typedIPC零参数也有回归，31项定向通过。
- COUNT仍需检查演员路径字段，非恒定工作量，未增加索引或缓存。startAllAvatars仍全量枚举目标并继承旧作品数量排序；任务队列内存、计数到启动间变更、并发启动边界仍待后续处理。本批不宣称完成批量构图优化，不新增p95/Windows/HDD/冷盘/真实IPC或峰值结论，完整15/42计划保持进行中。

- 最终全量2,270通过、1跳过、0失败（2,271项），build成功，两路只读静态审查无剩余阻断。[本批红绿回归、全量/构建日志、审查与源码快照清单](large-library-results/implementation/batch-ay-manifest.json)共6份artifact的SHA256已核验。未访问用户数据或媒体、修改schema、提交、推送或发布。


## 后续批次 AZ：头像构图窄目标清单与启动互斥

- 用户明确认为按作品数排序无意义并授权移除；目标清单改按ID升序，只读取演员ID和完整名称。复用AY路径条件，保留全部性别、空格/NUL非空路径，不检查文件。移除旧全演员DTO、作品计数、成员去重、写真统计和作品排名；typedIPC/preload/QueryService贯通实际Provider启动读取。
- startingRef在首个await前阻止重复启动，并让刮削自动构图避让准备中的手动任务；先取得原mediator全局锁再读取清单。空清单和读取失败释放锁；卸载后晚到锁直接释放，晚到目标不启动处理。正常任务将锁交给原drainQueue，结束后释放。目标清单仍全量，完整名称没有字节截断；未宣称任务内存有界。
- 28项定向通过。repo与旧目标集合完整字段等值并按新合同显式重排，夹具作品排名与ID顺序不同，可捕获旧排序残留；断言SQL不读取关系/宽字段。Provider覆盖同周期重复启动、获取锁期间不读目标、目标失败/空、卸载后的晚到锁/目标，以及按传入[7,2]顺序处理两项无源头像、done和一次end。正常测试未用处理中门闩单独断言end绝不提前，静态移交路径已复核。
- 独立合成库1万演员、每项4KiB简介、10万影片/关联、15万成员、6667目标，ANALYZE/预热后3次热样本：旧全列表中位170.326ms/45,421,022B；新目标清单1.041625ms/292,612B。固定先旧后新，计时不含断言与序列化，oracle保留内存；不是p95、冷盘、Windows/HDD、真实IPC往返或峰值。按用户新合同更改排序，不能声称旧/新顺序完全一致。
- 仍需处理目标清单分页、运行中卸载生命周期、pending数组shift、日志增长与完整计划其他工作包；本批不关闭整体头像构图风险，完整15/42计划保持进行中。

- 最终全量2,273通过、1跳过、0失败（2,274项），build成功；两路只读审查无剩余阻断。[本批源快照、定向/全量/构建、基准与审查清单](large-library-results/implementation/batch-az-manifest.json)共6份artifact的SHA256已核验。无用户数据/媒体访问、schema变更、提交、推送或发布。


## 后续批次 BA：头像队列卸载互斥与顺序取出

- 实际Provider处理门闩复现：已进入getAvatarSourceInfo但尚未返回时卸载，原cleanup立即end锁，断言active crop must retain the lock until it settles失败。修复为运行中卸载只标记取消并清空等待目标，由当前项结束后的drainQueue finally释放锁；准备阶段的卸载清理沿用AZ。没有强制中断正在执行的读图、推理或提交，保留当前项自然结束语义。
- 队列改为一次复制并反转后从尾部pop，保持原输入顺序和调用方数组不变，消除每项shift移动剩余数组的重复工作。移除仅写入/删除/清空而没有任何读取用途的queuedIdsRef，不再构造重复ID Set。本批未声称固定内存上限，初始化仍有线性数组复制。
- 最终两项实际Provider定向测试通过（扩展既有Start测试的门闩情景，未增加测试项计数）：正常[7,2]顺序；卸载前11在途、锁未释放，返回后不启动12并仅end一次；手动停止时21结束而22跳过，最终total2/current1/cancelled=true且只end一次；输入数组仍[21,22]。之前启动、空/失败及计数回归仍保留。该证据没有运行真实图像模型，不支持真实推理耗时或Electron断连行为的性能结论。
- 仍需目标清单分页/快照、日志字节预算及完整计划其他工作；未将局部互斥修复等同于整个头像任务生命周期和内存验收完成。完整15/42目标保持进行中。

- 最终全量2,273通过、1跳过、0失败（2,274项），build成功；新增情景位于既有test，测试项数未增长。两路只读静态审查无阻断，[红绿回归、全量/构建、审查与源码快照清单](large-library-results/implementation/batch-ba-manifest.json)共6份artifact的SHA256已核验。未访问用户数据/媒体、修改schema、提交、推送或发布。


## 后续批次 BB：头像日志预览上限与省略提示

- 头像构图日志当前仅用于任务详情的可复制文本，没有持久化/独立导出入口。本批明确改为最近200条预览；每项time/code/message分别最多64/128/1024个UTF-16单元，超长截断时不切开有效代理对，保留省略号。每项追加只复制有界尾部，任务日志数增长不再令整个历史数组重复扩大。200项文本字段最多243,200个UTF-16单元，不包含对象/数组/React/临时字符串开销，不能换算成实测堆峰值或全局内存保证。
- Provider七个日志入口统一使用helper，totalLogCount和shortenedLogCount独立累计，新任务从初始状态重置。shortened计数包含已经淘汰的历史日志，不只当前200条。成功/失败/跳过/进度计数完整保留。Settings详情明确提示最近200条、较早日志省略数和长文本截断数，避免将当前预览当作完整日志；滚动依赖累计日志数，达到200条后仍会触发。
- 五项定向通过：helper追加100,000条后保留99800…99999，长NUL/emoji字段长度、有效代理对及输入不可变性；实际Panel的React TestRenderer验证200个日志节点与完整500/500计数；实际Provider230个任务产生232条累计日志，保留200，任务完成/跳过仍230且结束日志存在，之前取消/卸载/启动回归保留。前述Panel测试不是浏览器布局验收。
- 最终全量2,276通过、1跳过、0失败（2,277项），两路只读静态审查未发现阻断。没有真实图像模型、目标清单分页、全局渲染预算或Windows/HDD长跑结论；完整15/42范围保持进行中。

- 最终build成功；真实Modal/Panel/styles浏览器夹具在1000×640与1440×900验证200条DOM日志、提示可见、无文档横向溢出/pageerror，已查看两张截图。满额后的自动滚动仅验证接线，未单独动态断言。[源码、测试/构建、浏览器截图/结果与审查清单](large-library-results/implementation/batch-bb-manifest.json)共9份artifact的SHA256已核验。无用户数据/媒体访问、schema变更、提交、推送或发布。


## 后续批次 BC：头像目标快照与游标接口（前端待接入）

- 新ActressAvatarCropSnapshot在首次目标页请求时，以事务建立随机名称TEMP表，固定本次符合原头像路径条件的演员ID与名称前516字节。每页按主键ID>afterId读取101项、返回最多100，以额外一项判断nextAfterId；名称显示保留128个Unicode码点及省略号，主业务仍以ID识别。总数固定，后续新增、删除、改名不改变快照；删除目标后真正处理时仍应按现有服务读取，交由前端正常跳过/失败统计。
- 新scrape typedIPC/preload avatarAutoCropBatch.targets(token,afterId)经JobController/Mediator提供接口。仅持有当前批量token可读取，首请求才创建，失败可重试；end、初始化clear和renderer断连清理快照。数据库连接关闭后快照失效，dispose不重新打开数据库。准备的是单次会话快照，不提供崩溃后任务恢复。
- 审查发现dispose异常原本会阻断断连的等待请求/定时器清理，已修为先使token失效，隔离异常并保留失败快照供重试；下次begin须先清理成功，否则拒绝开始新任务，防止连续累积快照。故障回归覆盖disconnect pending结算、旧token拒绝、清理失败时新任务受阻、恢复后新快照及end失败后的重试。两路复核结果和最终验证见收尾。
- 31项定向通过。10,001目标（每项4KiB简介）在首读后删除101、改名102、新增10002，遍历结果仍为1…10001且名称保持；单页≤100，夹具JSON<100KB，长emoji标签截断；另测空库、坏游标、dispose幂等/关闭连接、注入INSERT失败后TEMP表事务回滚。Mediator验证单快照复用、错误token不创建/不释放、重启/断连、失败创建重试，IPC验证安全整数游标。初轮全量的测试cursor变量窄化类型错误已修为number|null，保留失败日志，运行时测试原本通过不代表类型门通过。
- 该接口尚未接入实际头像队列，当前Provider仍使用AZ完整清单，不能宣称UI已分页。TEMP表仍有O(目标数)存储与同步初始化扫描/复制，实际存储介质依运行时SQLite配置；主进程阻塞、磁盘满/目标硬件矩阵及前端消费/取消仍待验证。没有持久schema迁移、用户数据/媒体访问、性能耗时/峰值内存或p95结论；完整15/42目标保持进行中。

- 最终全量2,283通过、1跳过、0失败（2,284项），build成功；两路静态复核确认清理异常阻断已闭合。end返回true仅表示token结束，不保证临时表当次释放成功。[源码、初始类型失败、最终测试/构建与审查清单](large-library-results/implementation/batch-bc-manifest.json)共6份artifact的SHA256已核验。


## 后续批次 BD：头像队列逐页消费快照

- 实际AvatarAutoCropBatchProvider接入BC token快照页：启动读取0游标的首100项，以快照total初始化任务；当前页耗尽后才读取nextAfterId，无预取/历史页累积。页内复制反转后pop，处理顺序沿用快照ID升序；日志仍受BB200条与单条文本上限约束。旧完整目标API仍保留供已有代码/基准使用，但此实际队列不再调用。
- 后续页返回前保留任务锁；停止或卸载时丢弃等待项，晚到页不会处理也不会启动下一次读取，finally再end释放快照。取消后的晚到页错误不计失败。未取消时读取/设置错误使任务终止，剩余total-current（包括未加载页）计失败，并在日志明确“X项未处理，计入失败”；不把未处理项假装为已经尝试裁剪。
- 三项实际Provider定向通过。230项按0/100/200游标消费且ID完整有序、完成/跳过230，日志200；第二页失败后仅处理100项，失败130且日志明确未处理；第二页在途的cancel/unmount/取消后reject均保持锁至读取结束、不处理101及后续项、end一次，取消时current100/failed0。AZ–BB的启动/空/故障/卸载/日志回归保留，原mock也改为100项分页。临时恢复完整清单读取后同一Paging测试因Full targets forbidden失败，finally已还原最终源码。
- 该证据证明实际Provider的请求与状态行为，fixture未跨真实Electron IPC或运行图像模型；BC后端另有快照集合/清理验证。每次最多100项返回和有界显示标签，不等于整个应用/SQLite恒定内存：TEMP表及同步初始化仍O(目标数)，连接失败/磁盘满/真实裁剪写入/目标硬件和长期并发矩阵继续保留。完整15/42计划保持进行中。

- 最终全量2,284通过、1跳过、0失败（2,285项），build成功，两路只读静态审查无阻断。[全清单回放红例、最终定向/全量/构建、审查与源快照清单](large-library-results/implementation/batch-bd-manifest.json)共6份artifact的SHA256已核验。首屏准备阶段卸载仍立即end；晚到拒绝仅单独验证cancel场景，unmount共享该分支的静态逻辑。无用户数据/媒体访问、持久schema修改、提交、推送或发布。


## 后续批次 BE：头像快照初始化取舍测量

- 新[评估报告](large-library-avatar-snapshot-evaluation.md)及可复跑探针比较10k/100k演员的完整窄清单、创建快照并取首100项、已有快照首末页。每项ANALYZE/预热后20热样本，明确偶数median与nearest-rank p95，计时排除断言/序列化/dispose；不是冷盘、Issue100演员分布或Windows/HDD复现。
- 最终100k演员：完整清单median21.4146ms/p95 23.3736ms/4,588,896B，创建快照并取首页23.0567ms/23.4442ms/4,336B。已有快照首末页median0.0440/0.0481ms，参数化EQP使用INTEGER PRIMARY KEY范围查找。收益是返回量和后续读取，初始化并没有更快；20样本小差异不当作稳定退化比例。保留快照，不调整SQLite默认参数，初始化offload评估继续留在10/00。
- TEMP pager在10k/100k为51/516页，DROP后表消失、freelist50/515、page_count不下降；不是RSS或OS释放内存证据。完整遍历仅断言所有ID一致，不扩大成全DTO等值。静态测量审查无阻断，最终独立探针退出0；没有生产变化，不重复全量/build，BD仍为最后生产验收。
- [原始20样本、EQP/参数、脚本、评估和审查清单](large-library-results/implementation/batch-be-manifest.json)共5份artifact的SHA256已核验。无用户数据/媒体访问、schema/生产代码变更、提交、推送或发布；完整15/42目标仍进行中。


## 后续批次 BF：插件测试演员候选与完整身份接口（页面待接入）

- PluginDevMediaTargetPicker原本读取所有female演员宽列表再截80项。新testTargetPage经QueryService/typedIPC/preload提供默认40、最多100的窄候选页，复用AU的有界名称/头像、owned-name搜索和参数上限。抽出内部queryActressPickerPage(query,gender)，旧身份picker仍all，新测试候选严格female（null/male仍排除），按完整名称/id排序；原legacy list作品排名合同不变。
- 列表短标签不能作为插件测试输入。新增testTargetGet按ID只读取当前female演员的完整main_name，由服务复用既有normalizeRunTargets进行NFKC/空白规范化及160 UTF-16单元、控制字符/URL/路径校验；返回真正运行身份或null/明确错误。150个A的标签虽截为128+省略号，get仍返回150字符原身份，不使用有省略号的标签代替。允许旧规则可规范化的长原始空白字符串，没有在规范化前擅自添加原始长度限制。
- 46项定向通过：female范围/owned alias与转义搜索/按名称分页和无作品写真简介投影、当前性别/缺失/ID边界；150字符主名、两侧各5000空白+全角名字规范化、161长度/NUL/URL拒绝、gender变化后null；另跑AU picker及插件运行目标既有测试，IPC拒绝非法页边界和越权gender参数。
- 这是后端准备，实际选择器仍调用旧全量列表，不能宣称插件候选界面已有性能收益。下一步接入分页、点击身份读取、旧返回隔离、错误重试和选中保持。GET只有一个原始名称字段，但读取/规范化该单字段的工作内存仍随其原始长度增长；返回身份受160单元限制不代表全局内存恒定。没有schema/用户数据/媒体访问、性能基准或目标平台结论；完整15/42目标保持进行中。

- 最终全量2,287通过、1跳过、0失败（2,288项），build成功，两路静态审查无阻断。[定向/全量/构建、审查与源快照清单](large-library-results/implementation/batch-bf-manifest.json)共5份artifact的SHA256已核验。当前UI迁移仍待完成。


## 后续批次 BG：实际插件测试演员选择器分页与完整身份

- 实际PluginDevMediaTargetPicker接入BF testTargetPage，每页40项，不再全量加载演员宽资料；搜索回首页，原始输入立即隔离旧结果，分页失败可重试。video保留原60项查询合同。kind变化重建会话，搜索/翻页/关闭隔离晚到选择，同一事件周期仅接受一次选择请求。
- 点击按ID读取真实规范化名称，保留150字符身份而不提交截断标签。缺失、含目标分隔符及超出原8个目标上限均明确报错；上限按原始selectedValues数量判断，与运行时一致。已解析ID/名称缓存最多100项，非LRU保证。
- 已选项含长名称时，对当前页截断标签按ID核对完整身份，最多40项、每批4个worker；取消停止继续调度，已发请求仍自然结束。不同批次重叠不承诺全局4并发。核对失败明确提示并支持重试；共享截断前缀不误判，关闭重开保持已选状态。
- 9项实际组件交互测试通过，覆盖40→40→21、搜索/错误重试、重复点击/晚到请求、关闭/kind隔离、缺失/分隔符/8项限制、长名重开/共享前缀、4worker取消及核对错误重试。全量2,296通过、1跳过、0失败（2,297项）。原controller测试相对HEAD仍27新增、0删除。
- 实际组件/styles与合成API浏览器覆盖1000×640和1440×900。新增头像几何断言复现110px覆盖38px的布局错误；修正优先级并保持50%圆角，最终头像38px位于54px行内，分页可达、无横向溢出/pageerror。已查看最终短窗口正常截图与大窗口错误截图；最终CSS后浏览器与build通过。两路静态审查已知阻断均关闭。
- [源快照、测试/构建、布局红例及最终浏览器结果/截图、审查清单](large-library-results/implementation/batch-bg-manifest.json)的SHA256已核验。此为合成API交互与布局证据，不新增真实IPC/p95/峰值内存/Windows/HDD结论。无用户数据/媒体访问、schema修改、提交或推送。原始扫描审计分页、实体详情、扫描流式化及其他工作包仍未完成，完整15/42目标保持进行中。


## 后续批次 BH：演员作品窄卡片分页后端（页面待接入）

- 新listActressVideoPage经QueryService/typedIPC/preload提供默认60、最大240的作品页，MATERIALIZED先限定ID再投影共享VideoCard。保留活动库未隐藏成员EXISTS及跨库去重，日期/add_time降序后新增ID升序稳定同值。事务内存在性、精确总数和页一致；缺失演员null，无作品返回空页。
- 最终29项定向通过：262可见作品全分页卡片等值、跨库重复/隐藏/归档/孤立、null/空串日期及不同add_time、多资源顺序/pending、边界及外部WAL在count后隐藏的当前/下一次快照。初轮全量2,300通过、1跳过、0失败（2,301项）；后续只增强测试，最终定向、typecheck、build通过，两路静态无已知阻断。
- [独立评估](large-library-actress-video-page-evaluation.md)：5万关联作品、每项4KiB简介，3个热样本中位旧详情453.678ms/231,239,374B，首60卡片90.127ms/7,779B，末60卡片101.271ms/7,972B。不是p95、冷盘、目标平台、IPC或峰值内存结论。捕获页面EQP仍扫描影片日期索引并临时排序，不能声称只做本页工作；count未单独测量。字符串字节和单片资源聚合尚无硬上限。
- 实际详情页及编辑封面仍调用旧get；下一步须拆元数据、作品总数、分页作品和按需封面候选，不能仅前端slice。未关闭PERF-05/06/10/12或完整15/42计划。[本批源快照、测试/类型/构建、基准及审查清单](large-library-results/implementation/batch-bh-manifest.json)8份artifact SHA256已核验。顺带清理BG选择器一行空白，无行为变化；无用户数据/媒体访问、schema改动、提交或推送。


## 后续批次 BI：演员资料与作品分离、分页前筛选封面

- 抽出getActressMetadata，返回ActressMetadata（完整Detail除videos）；QueryService/typedIPC/preload新增metadata。原getActressDetail复用资料后继续原全量作品SQL，保留已有调用者合同。metadata不查作品、关联或资源；仍完整读取名字、别名、写真及相关链接，不声称元数据字节有界或多查询事务快照一致。
- BH videoPage增加可选withCover boolean，默认false/省略保持原作品范围；开启时在count与MATERIALIZED ID页之前统一过滤BLOB长度>0的cover_path。与旧编辑器Boolean(cover_path)一致：排除null/空串，保留空格及NUL非空路径。这样封面候选不会先按全部作品分页、再前端过滤造成空页，仍不检查图片文件是否存在。
- 定向32项通过。新metadata测试禁止video_actress/video_resources/FROM videos/pending SQL，并明确核对中文名、别名、简介、有序写真、链接和缺失演员；与当前legacy对象等值共享实现，不单独作为独立oracle，静态审查另对照旧源码。封面六种路径按两项翻页、完整ID集合/总数及false不筛选有断言；typedIPC验证ID及严格boolean。两路静态审查无阻断。
- 实际ActressDetailPage和EditActressModal/ActressAvatarEditor仍尚未切换；下一步必须同时接入metadata与作品页，以页total显示完整作品数，让头像编辑按需请求withCover分页，保持裁剪源选择独立于候选当前页。要验证actor变化、翻页/失败重试/旧响应、嵌套影片返回位置及封面翻页后的裁剪状态，不能仅用后端接口通过来关闭F01/F04。
- 全量与构建、artifact核验在本节收尾记录。完整15/42计划持续进行，写真分页、长字段预算、查询隔离和剩余工作包不因此完成。无用户数据库/媒体访问或schema变更。

- 最终全量2,303通过、1跳过、0失败（2,304项），build成功；[源快照、定向/全量/构建及审查清单](large-library-results/implementation/batch-bi-manifest.json)5份artifact SHA256已核验。原controller测试保持相对HEAD27新增、0删除。未提交、推送或发布。


## 后续批次 BJ：演员详情及头像封面实际分页

- 实际ActressDetailPage改读metadata，作品由useActressVideoPage独立读取，每页60张窄卡片；翻页不重读metadata。EditActressModal接收metadata，头像编辑器挂载时才请求withCover页，单页60个封面；本批仍完整保留写真。作品概要和合并弹窗显式传服务端total，不再用当前页长度冒充总数；刷新时已打开合并弹窗的实例、输入及125总数保持。
- hook仅持有一页结果，actor/filter/offset导航会话与reload请求版本分开。换页面会话隔离旧数据/晚到请求，当前页刷新保留成功卡片，失败可重试；删除导致越末页自动回到有效末页。actor A→B在途→A有实际红例60张旧卡误显示，新增generation后当前A返回前为0卡，晚到B也不落地。offset ABA复用同一机制，当前仅静态覆盖；不声明100页全局缓存或像素滚动锚点已验收。
- metadata load增加序列/actor guard，并在任何序列递增/刷新作品前拒绝旧actor调用。实际旧编辑保存挂起、切B metadata挂起、旧保存完成的红例显示B永远loading；修后B正常显示且没有第三次旧actor metadata请求。此证据针对资料读取归属，不扩大为全部变更命令和所有弹窗生命周期已隔离。
- 头像候选页变化不重置选中源或裁剪状态；首次封面结果迟到时不会覆盖用户已选的本地tab。分页栏放在绝对定位的来源图片区外，使用现有Button和语义token。真实组件/styles浏览器在1000×640与1440×900验证作品和封面60→60→5、完整125计数、已选封面翻页往返保持、实际键盘将zoom从1调到1.01后翻页保持；分页在图片区之外且可达，无文档横向溢出/pageerror。已查看最终大窗口编辑截图及前一等布局短窗口编辑/大窗口作品截图。
- 浏览器使用合成API及本地SVG替代media协议，只证明交互、DOM与布局，不证明真实IPC、图片处理/数据库吞吐或原始媒体字节。首次夹具漏闭合对象导致编译失败，修夹具；初次zoom断言过早发生在打开图片期间，改为等待aria-busy=false及编辑栏显示后通过，不能将这次初始化覆盖视为分页丢裁剪状态。
- 最终定向15项通过，包含原合并和裁剪回归、5项实际详情测试及2项新增封面测试。首次全量被CSS架构门阻止：新增测试用className.includes寻找封面tile，被归为样式驱动行为；改用aria-label选择测试对象，未放宽门规则。最终全量/build及artifact见收尾。完整15/42计划仍在进行；长字段/写真、查询隔离、深页及其余工作包保留。

- 最终全量2,310通过、1跳过、0失败（2,311项），build成功；[源码快照、两项竞态红例、定向/全量/构建、初始架构门、浏览器结果/截图与审查清单](large-library-results/implementation/batch-bj-manifest.json)13份artifact SHA256已核验。原controller测试仍27新增、0删除。无用户数据/媒体访问、持久schema变更、提交、推送或发布。


## 后续批次 BK：保持全局显示顺序的写真分页后端

- 新galleryPage经QueryService/typedIPC/preload提供默认60、最多100的写真页。SQL按ECMAScript trim过滤来源，BLOB长度保留NUL；计算比值有限且>1的正宽高图片优先，再按position（null视0）和id。排序在LIMIT前完成，limit1保持全局首项语义；同一事务count与page。未改schema或枚举真实图片文件。
- 31项定向通过，891组来源/尺寸/position组合对照原prepareActressGalleryForDisplay，逐页完整字段/顺序等值；包括Unicode空白、零宽字符、NUL、缺失/无效/无限及溢出比例。另覆盖空/缺失、分页边界、外部WAL在count后移除来源时当前快照仍1/下次0及IPC合同。两路静态审查无阻断；不扩大为任意损坏动态类型数据的全矩阵。
- [独立评估](large-library-actress-gallery-page-evaluation.md)：5万记录、4万有效图库，旧metadata读取+JS准备中位26.028ms，首60项23.613ms，末60项47.441ms；JSON分别16,338,225B、24,383B、24,591B。旧JSON仅准备图库数组，新JSON带分页包装，不冒称旧metadata完整IPC体积。3个热样本、计时外校验/序列化、固定顺序、oracle驻留；无p95/目标平台/真实IPC/峰值结论。首页页面EQP使用actor索引及临时排序，未独立捕获count或末页计划。
- 深页确实更慢，保留分页作为载荷/DOM改造基础，查询开销继续归PERF-10/12评估，不声称全面提速。实际metadata与写真/头像编辑仍全量gallery；下一步须同时拆窄profile的默认背景首项、写真/头像候选、预览跨页、导入删除刷新和选择状态。长路径无硬字节预算；完整15/42计划保持。
- 最终全量2,314通过、1跳过、0失败（2,315项），build成功；独立探针通过。[源码、定向/全量/构建、原始样本/EQP、评估及审查清单](large-library-results/implementation/batch-bk-manifest.json)7份artifact SHA256已核验。原controller测试仍27新增、0删除；无用户数据/媒体访问、提交、推送或发布。


## 后续批次 BL：不携带写真全集的资料头与默认首图

- 新profile typedIPC/preload经QueryService读取ActressProfile：核心字段、名字/别名/链接保留，替换完整gallery为gallery_count（所有记录）、display_gallery_count（有效显示来源）与first_gallery（全局首图或null）。区分数量口径，避免后续合并弹窗丢失原gallery.length语义。原metadata/get合同不变，提取共享核心字段函数；新profile外层读事务包含全部读取。
- 背景helper接受旧gallery或新first_gallery两种来源，保留显式poster优先、关闭fallback不读首图的规则。10,001照片测试禁止作品SQL且写真SELECT *必须LIMIT、返回最多一行；profile与旧资料字段/双计数/首图和背景对照。字段helper共享实现，等值断言不单独作为独立转换oracle，静态另核对旧代码。WAL在核心资料读后插入横图，当前count1/first1，下一次count2/first2；空/缺失及非法ID有覆盖。
- 最终39项定向通过，全量2,317通过、1跳过、0失败（2,318项），build成功，两路静态审查无剩余阻断。独立探针扩展为完整metadata和完整profile返回对比：[评估BL节](large-library-actress-gallery-page-evaluation.md)5万记录旧25.741ms/17,705,474B，新23.987ms/924B；1万旧4.462ms/3,525,474B，新4.883ms/923B。3热样本不足以证明稳定提速，计数/排序仍线性或更高；923/924B是夹具结果，不是API上限。
- 实际页面仍读metadata，写真/头像写真候选尚未分页接入，不能声称本批已减少实际页面初始载荷。下一步需统一迁移profile、照片页与跨页预览，使用两个明确计数及首图；名字/链接/简介/首图路径的字节预算继续保留。完整15/42目标持续进行。
- [源码、定向/全量/构建、独立样本、评估和审查清单](large-library-results/implementation/batch-bl-manifest.json)7份artifact SHA256已核验。无用户数据/媒体访问、持久schema改动、提交、推送或发布。


## 后续批次 BM：头像写真候选分页与共享页面会话

- 将BJ的单页/generation/同页刷新/越界回退逻辑提取到useBoundedMediaPage，video/gallery wrappers用稳定回调和不同scope调用，当前合同均为60项。实际ActressAvatarEditor不再接收gallery数组，改为读取独立照片页；EditActressModal的Avatar key包含演员ID及头像revision。两种候选各保留一页，最多各60个候选节点；不称整个编辑器只有60节点。
- 原头像map跳过没有本地路径的写真，故galleryPage新增localOnly严格boolean。开启时先按原DISPLAY_SOURCE过滤，再以BLOB非空模拟原Boolean(local_path)，两项均在count/LIMIT之前；普通图库默认不加此条件。891组合oracle新增原显示集合再过滤本地truthy的完整字段分页等值。只表示记录有本地路径，不检查文件存在/可裁剪性。
- 写真候选用当前筛选集合offset+index编号，分页失败可重试；初始默认来源等待两类页返回，用户切tab或点击本地文件按钮后不被迟到结果覆盖。候选封面/照片展示使用320缩略图，选择后裁剪仍读取原始URL和本地asset path，算法与保存身份未改。
- 52项定向通过，覆盖旧作品/合并/裁剪/ABA/元数据边界及新增照片60→60→5、全局候选编号、错误重试、actor/query参数、本地文件按钮意图保持与320图片路径；未模拟真实系统文件选择器。首次照片分页测试暴露label仍从1开始，修为offset+index后通过。
- 真实页面/编辑器/styles合成API浏览器在1000×640和1440×900验证封面与写真各60→60→5、已选来源与键盘调整zoom=1.01跨页往返保持、照片pager在绝对图片区外且可达，无文档横向溢出/pageerror；已查看最终短窗口照片编辑截图。请求URL断言验证两种候选size=320而选源请求不带size；本地SVG替代media协议，不作真实缩略图解码、IPC或字节/峰值性能推断。
- 两路静态审查未发现本范围阻断。主ActressDetailPage仍读metadata、主写真列表/跨页lightbox及profile接口尚未迁移；parent仍可能持有gallery全集，此步只是候选请求与DOM有界，不关闭全部F01/F04或全局预算。完整15/42目标保持，最终全量/build及artifact见收尾。

- 最终全量2,320通过、1跳过、0失败（2,321项），build成功；[源码、标签红例、定向/全量/构建、浏览器结果/截图/资源URL及审查清单](large-library-results/implementation/batch-bm-manifest.json)11份artifact SHA256已核验。原controller测试仍27新增、0删除；无用户数据/媒体访问、持久schema改动、提交、推送或发布。

## 后续批次 BN：主写真分页、资料概要与跨页预览

- 实际ActressDetailPage从metadata切到profile，初始资料不再携带完整gallery；EditActressModal/ActressProfileMeta接受核心字段，MergeActressModal用显式gallery_count保留全部物理写真计数并兼容旧调用者。主页面测试与浏览器fixture禁止旧get/metadata，确认作品翻页、写真浏览和编辑接线不依赖全集。
- 主ActressGalleryPanel按需请求60张显示写真，瀑布流只构建当前页；数量显示服务端有效显示总数，编号为offset+index。预览独立持一页，网格与预览合计最多两个60项窗口；filmstrip本地图片用320缩略图，网格640，主预览/设背景仍为原图与原始路径。打开预览保持一个history entry，跨页不追加历史；关闭后网格保留原页。
- 新useActressGalleryPreview把预览页和选中索引一起提交；请求失败保留旧照片、可重试，关闭/卸载使旧响应失效，演员切换由keyed Panel隔离。资料刷新按稳定照片ID重新定位，照片消失关闭预览，避免误选同索引的新照片。galleryPage新增anchorId/anchorIndex，按相同过滤与全局排序在读事务中定位后取页；默认接口合同不变。ROW_NUMBER仍需处理演员图库，计数/排序/深offset与anchor工作量未变为常数。
- 共享Lightbox的windowOffset/total/loading均有旧调用默认值；全局计数/缩略图编号、键盘/按钮/手势支持跨页。审查发现慢请求时旧手势会滑入未加载空白，已改为页边界保持旧图位移0、释放后加载，成功才换图；同页保留原滑动动画。加载/失败操作栏持续可见，避免重试被自动隐藏。
- 新组件测试使用真实GalleryPanel与真实分页/预览状态hook，仅替换Lightbox portal边界：覆盖60/60/5、双向预览跨页、单history entry、失败重试/关闭后迟到响应、刷新重排保留ID与删除关闭、末页121删除后的60项回退、真实ImportModal回调导入后新末页与背景回调刷新保留ID。导入和背景使用合成API，不证明真实文件导入/背景持久化。数据库测试验证anchor重排/演员隔离/localOnly/消失与非法ID，IPC拒绝非法anchor。
- 实际浏览器在1000×640与1440×900运行页面/Lightbox/编辑器/styles与合成API、本地SVG替代media协议，覆盖网格60/60/5、预览键盘/按钮/真实pointer跨页与全局终点、慢请求保留当前图/持续加载栏、关闭保留末页，以及原作品/头像候选翻页和裁剪1.01状态。实测断言/截图收录于本批artifact；不将此作为真实图片解码、IPC耗时、内存峰值或Windows/HDD证据。
- 未新增持久schema、用户数据访问或提交推送。名字/链接/简介/路径字节预算、全局在途请求预算、其他实体列表窗口、跨页数据变化的全局一致性、冷盘/目标平台及完整15/42工作包仍未完成。本批只关闭实际演员主写真全集加载与预览DOM扩张路径，不将分页API视为查询恒定时间或全计划完成。

- 最终60项定向通过，全量2,325通过、1跳过、0失败（2,326项），build成功；两路静态审查无剩余阻断。真实浏览器最终慢请求位移matrix(1,0,0,1,0,0)、chrome opacity=1，错误重试与原图加载后截图均通过。短窗口图库pager及大窗口最终预览已目视核对。[源码、日志、浏览器结果/截图与审查清单](large-library-results/implementation/batch-bn-manifest.json)15份artifact SHA256已核验；原controller测试仍27新增、0删除。

## 后续批次 BO：系列与机构主列表服务端分页

- 实际SeriesListPage/OrganizationListPage原先每次读取完整实体数组；新增series.page/organizations.page并接入页面，每页60，上限100。旧list合同及其他调用者保持。分页接口经ClassificationQueryService、typedIPC/schema/preload贯通；count与MATERIALIZED页在一个读事务内，封面/owner等展示字段在页选出后投影。保留主名/别名规范化与字面通配符搜索、maker/publisher角色、影片数量/更新时间双向排序与ID次序；影片计数仍是原有全部videos口径。
- 新useClassificationPage统一URL facetOffset（60整页、安全非负数、非法回到0）、query key、搜索/排序回首页、越界回退与失败重试；不显示旧页placeholder卡片。使用gcTime0清理不再观察的页，嵌套ListDetailShell保持当前observer与页面。资料详情返回保留页码，组件测试同时验证保存的scrollTop。该缓存结果不代表所有全局QueryCache或并发在途请求都有上限。
- 搜索同步重写为草稿与当前导航上下文绑定。Spec发现字符串上下文导致A→B→A旧草稿复活，以及输入后进入详情仍提交；已将location.key/path加入上下文并在离开时清空draft，真实页面与浏览器覆盖两种回归。两个审查方向最终无剩余本范围阻断。
- 数据库125实体夹具跨4种排序、4种搜索、系列/机构两角色完整字段逐页与原list对照；包含空/缺失封面、owner、重复排序键。另验证外连接修改角色时count/page保持读快照，以及服务和IPC页边界。独立[10,000实体/100,000影片探针评估](large-library-classification-page-evaluation.md)：旧全列表30–33ms/1.42–2.01MB，分页3–6.5ms/5.7–11.9KB（完整页对象）。一次预热后3热样本，固定旧查询在先，断言/序列化不计时，完整oracle留内存；不作为p95、冷盘、IPC、峰值或Windows/HDD结论。
- 实际浏览器运行页面、ListDetailShell、QueryClient与styles，合成API禁用旧list：系列/maker×1000×640/1440×900四组合均验证60/60/5、错误重试、详情返回页码、草稿导航隔离、搜索归零；连续100页后60张卡片、完成查询cache仅当前1项，无页面错误与横向溢出。截图已目视核对短窗口系列及大窗口机构。合成API/无真实封面，不证明真实IPC或图片资源压力；浏览器不替代组件scrollTop断言。
- 未增加持久schema或用户数据访问，未提交/推送。按影片数排序、精确count、搜索及深offset仍有随规模增长的工作量，主线程查询、长字段字节和其他实体/选择器完整list调用仍待处理；本批不关闭完整PERF05或15/42计划。最终全量与artifact见收尾。

- 最终53项定向通过，全量2,344通过、1跳过、0失败（2,345项），build成功；[源码、红例、查询基准、日志、浏览器截图/结果与审查清单](large-library-results/implementation/batch-bo-manifest.json)14份artifact SHA256已核验。初次CSS门禁拒绝测试的className子串选择器，改精确节点选择后通过，未放宽规则；controller测试仍27新增、0删除。下一明确入口为仍使用完整list的DirectorListPage。

## 后续批次 BP：导演主列表分页与缩略图

- 新directors.page经service/typedIPC/schema/preload接入实际DirectorListPage，默认60、最多100，复用BO分页查询与useClassificationPage。SQL明确使用directors/director_names/director_id，既不添加机构role条件，也不投影系列owner；旧list合同不变。count/排序/封面规则保留原全部videos语义，事务与LIMIT前全局排序沿用BO。
- 导演页面保留原名称搜索、双向排序、创建modal与/d/:id详情导航，新增服务器总数/前后页/失败重试/越界回退，URL页码、草稿导航隔离与ListDetailShell返回复用已验收路径。卡片显示从原图改640缩略图，保留显式imagePath与fallback优先级；通用实际组件测试新增两种路径URL断言。
- 125实体数据库oracle扩展导演，四种排序×四种搜索逐页完整字段对照旧list；新增导演服务/IPC边界及handler参数转发断言。真实导演组件加入通用分页/100页缓存/错误/缩小总量/搜索排序/ABA/详情导航和scrollTop测试；创建函数静态与原实现一致，本批未新增真实创建持久化验收。
- 独立[评估BP节](large-library-classification-page-evaluation.md)：1万导演/10万影片，旧全列表32.399–34.584ms/1,378,895B；首60项3.163–4.318ms/8,198B，末40项3.986–5.204ms/5,571B。一次预热后3热样本、固定顺序、计时不含断言/JSON，完整oracle留内存；不是p95、冷盘、并发、IPC或Windows/HDD证据，count/ranking仍随规模增长。
- 真实browser扩展到series/maker/director×1000×640/1440×900六组合，全部覆盖60/60/5、重试、实际Shell详情返回、草稿导航失效、搜索归零及100页后60卡片/完成query cache1。导演使用本地SVG模拟图片，所有捕获媒体请求size=640，两个窗口无横向溢出/页面异常；短窗口导演最终截图已目视核对。这里只验证URL与实际DOM/状态，不证明media协议解码或全局资源峰值。
- 两路静态审查无本范围阻断。未新增持久schema、用户数据访问、提交或推送；三个分类主列表已分页，但完整list保留供其他入口，图片候选/选择器、字段字节预算、主线程查询及完整15/42计划继续保留。最终全量/build及artifact见收尾。

- 最终60项定向通过，全量2,351通过、1跳过、0失败（2,352项），build成功；[源码、日志、查询基准、浏览器结果/截图与审查清单](large-library-results/implementation/batch-bp-manifest.json)15份artifact SHA256已核验，controller测试仍27新增、0删除。下一明确入口为ClassificationImageModal使用完整classificationImages.candidates数组并全量map的影片封面候选。

## 后续批次 BQ：分类主图封面候选按需分页

- 新classificationImages.page经QueryService/typedIPC/schema/preload连接实际ClassificationImageModal；默认60、最多100，正安全实体ID及页参数校验。保留原videos范围、SQLite trim封面资格、空日期优先规则、日期/add_time/ID倒序，组织双角色OR不重复；count/page同事务。完整candidates接口保持供其他潜在调用者，本批不修改持久schema。
- 实际弹窗移除完整数组useQuery，复用单页useBoundedMediaPage，仅影片封面模式且隐私允许时发请求；文件/URL模式不预加载。候选320缩略图，选中仍是videoId及原始URL，翻页/重试保留pending和预览。pager在候选绝对定位区域外，页变化重置横向scrollLeft。切隐私后恢复保留页码并重新请求，旧响应逻辑失效，非物理取消数据库读取。
- keyed内部editor按kind/id重置状态；activeRef使旧保存成功后不再调用新编辑器的onChanged/onCancel。URL原请求revision规则保持。没有独立裁剪状态；本批不改变文件/URL/移除主图的业务保存规则。旧保存失败toast等更广生命周期审计仍属于完整PERF06，未声称所有异步回调均重写。
- 3个后端测试覆盖175组封面/日期输入、三个实体完整字段逐页oracle、组织去重、WAL封面删除读快照、空/不存在与非法参数；真实组件4测试覆盖按需读取、60/60/5、失败重试、320/原图、离页选择保存原ID、越界回退、切实体迟到页/旧保存成功隔离及URL迟到不覆盖视频选择；IPC handler转发一起最终8项定向通过。
- 两个真实浏览器尺寸1000×640/1440×900，真实Modal/ThemeProvider/styles及合成API/本地SVG：页按钮可达且位于panel之后、保存按钮之前；60/60/5/错误重试、往返选中、保存原ID；隐私隐藏不发新请求，挂起页隐藏再恢复保留offset60、发新请求且pending CODE1保持；实体切换重置保存状态。请求URL验证320候选/原图预览，短窗口截图已目视核对。首轮测试错误地期待隐私恢复回首页，改为验证实际页保持与新请求，未为了测试改动页码行为。
- [独立查询评估](large-library-classification-image-evaluation.md)：五万候选旧约63ms/26.94MB；首60项约50ms/32.4KB，末20项约112ms/10.8KB。**深页比旧查询慢，主线程时延尚未解决**；本批确立返回/DOM有界，不能据此关闭查询性能风险。一次预热后3热样本，不含断言/JSON且保留oracle，不作p95/冷盘/IPC/峰值/Windows/HDD结论。下一步优先评估catalogReadWorker承接分类图片查询；现有worker仅tag读取，需保留32订阅上限、超时与DB身份/版本隔离，并验证真实worker读一致性。
- 两路静态审查无本范围阻断，无用户数据库/媒体访问、提交或推送。原字段字节、全局在途请求、更多选择器以及完整15/42目标继续保留；最终全量/build和artifact见收尾。

- 最终8项定向通过，全量2,358通过、1跳过、0失败（2,359项），build成功；[源码、日志、查询基准、真实浏览器结果/截图与审查清单](large-library-results/implementation/batch-bq-manifest.json)11份artifact SHA256已核验。URL迟到切源最终回归通过；controller测试仍27新增、0删除。完整目标继续，下一步以读取worker承接图片候选查询为优先评估方向。

## 后续批次 BR：分类封面分页使用共享只读 worker

- 实际CLASSIFICATION_IMAGE_PAGE handler改为catalogReadService.readImageCandidates，无同步查询fallback；SQL工厂注入worker只读连接。保留三个实体、封面/排序/count同事务和原分页合同，renderer未改变。主线程仍读取revision/PRAGMA，非零数据库调用。
- 标签与图片共享单worker、32订阅、串行执行槽及原超时/取消/换库屏障。合并键加入操作和实体，入队复制参数，结果按请求ID对应并独立克隆。未增加无界队列或持久schema。
- 最终32项定向通过：原标签生命周期，加混合容量/实体隔离/输入复制/取消/换库测试，真实worker三个实体多页完整字段oracle、写后可见、readonly与schema拒绝；实际handler测试禁止同步SQL。首次Promise.then包装引入微任务时序回归，改为请求操作对应的Promise类型收窄，原断言保留。
- [独立探针评估BR](large-library-classification-image-evaluation.md)：五万候选深页，同步111–130ms且计时器回调0；worker124–126ms、回调50–52、最大间隔2.594–2.730ms。32同页订阅合并1次发送。一次预热后3热样本，非p95/冷盘/Windows/HDD/真实IPC/峰值；SQL没有提速。worker启动加首读127.288ms，不是冷I/O。
- 两路静态审查无本范围新增阻断。慢图片仍占用共享worker，标签会排队；深OFFSET/count/sort、原生硬中断、字段字节预算及其他主线程查询仍需处理。前端未改变，沿用BQ浏览器证据，未重复运行。完整15/42目标保持进行中。

- 最终全量2,363通过、1跳过、0失败（2,364项），build成功；[源码、定向/全量/构建日志、探针及审查](large-library-results/implementation/batch-br-manifest.json)7份artifact SHA256已核验。controller测试仍27新增、0删除。无用户数据/媒体访问、提交或推送。下一步优先评估分类封面深页的排序/投影成本，并检查共享worker的混合负载等待，不能只以线程隔离关闭风险。

## 后续批次 BS：分类封面候选窄字段排序

- 在BR只读查询工厂内先以MATERIALIZED CTE选ID、release_date、add_time及empty_date并分页，再主键回表读取code/title/coverPath，外层重复完整排序。count/资格/组织OR/事务不变，未新增索引或schema迁移。
- 修改前后分别运行同一10k/50k合成探针，每种实体逐字段对照旧全量oracle。五万条首60从50.0–50.9ms降至27.0–27.7ms，末20从111.3–112.1ms降至40.4–40.8ms；各为一次预热后3热样本的中位数，返回字节不变。详见[评估BS](large-library-classification-image-evaluation.md)。资格仍读取路径，count/扫描/深OFFSET成本未消失；没有跨平台、冷盘、p95、峰值或混合worker排队证据。
- 原175组合包含NULL/空串/空白日期、路径资格、重复日期、组织双角色，逐页完整字段与旧查询等值；WAL修改覆盖count/page快照，真实worker覆盖三个实体与写后可见，共8项定向通过。只读静态审查无阻断。renderer未改，未重复浏览器；controller测试仍27新增、0删除。
- 完整15/42目标保持进行中。此处减少宽字段排序已取得收益，暂不因该查询新增持久表达式索引；其他数据分布、共享队列等待、扫描审计全量JSON等问题继续验收，不以本批替代整体完成。

- 最终全量2,363通过、1跳过、0失败（2,364项），build成功；[源码、前后基准、定向/全量/构建与审查](large-library-results/implementation/batch-bs-manifest.json)7份artifact SHA256已核验。无用户数据/媒体访问、提交或推送。

## 后续批次 BT：扫描清理资源引用分批枚举

- 实际ScanCoordinator默认资源依赖由全量list改为Iterable generator；在原清理事务内读取MAX资源ID上界，再主键游标每批256项，查询all完成后才处理删除。保留local/STRM资格、locator、ID顺序、授权、离线根保护、主资源晋升及整体回滚，没有提前让出或拆分事务。
- 初版执行计划选择库索引加临时排序，存在每页重复工作；改为NOT INDEXED主键范围访问，实测计划无临时排序。可能扫描目标库ID上界内的其他库资源，返回量上限不等于扫描量/字节上限；不新增schema。
- 真实DB1100混合资源/跨库交错完整字段对照、删除不漏项/整体回滚、空库/事务前置条件/新增超上界隔离；实际coordinator验证懒消费、unknown路径停止关闭迭代器，旧清理与大数组回归保留，共27项定向通过。
- [独立评估](large-library-source-resource-evaluation.md)：单库30万长路径资源，3热样本中位总枚举84.562→72.668ms，首项82.160→5.784ms；5万也验证。计时包含枚举校验和，排除断言，不执行文件检查/删除；不代表p95、冷盘、真实清理总耗时或峰值。原审计数组、JSON、逐资源查询及同步事务仍需优化，完整15/42目标继续。

- 最终全量2,365通过、1跳过、0失败（2,366项），build成功；[源码、初版计划、定向/全量/构建、基准及审查](large-library-results/implementation/batch-bt-manifest.json)7份artifact SHA256已核验。无用户数据/媒体访问、提交或推送。

## 后续批次 BU：移除非主资源清理的重复兄弟查询

- removeMissingAccessibleResources原本对每个待删资源都读取/filter整个同作品资源列表，但非主资源删除后直接continue，结果未使用。改为仅resource.is_primary时读取，主资源仍在原授权之后、删除之前加载，晋升及事务合同保持。
- 新5000同作品非主资源真实coordinator测试禁止listResources/晋升，核对全部删除及审计；修改前红例在首次无用查询处失败，修改后与原回归共28项通过。消除该路径每个非主资源一次完整兄弟列表读取，无新增schema或UI改动。
- [评估BU](large-library-source-resource-evaluation.md)说明潜在k×r传输/复制工作及边界。未声称所有删除线性、主线程无阻塞或测得峰值；主资源/审计/JSON及完整15/42计划继续。

- 下一审计入口已核查：libraryScanRepo.getLatestLibraryScanSnapshot在读取summary后还会解析整份audit_json，并全量返回library_unrecognized_files；现有前端分页不能消除这部分读取。后续必须同时处理快照合同和审计页入口，不能仅替换SCAN_AUDIT_GET。

- 最终全量2,366通过、1跳过、0失败（2,367项），build成功；[累计源码、红例、定向/全量/构建及审查](large-library-results/implementation/batch-bu-manifest.json)6份artifact SHA256已核验。无用户数据/媒体访问、提交或推送。

## 后续批次 BV：扫描历史只在使用时读取

- 调用方证据显示完整scan.latest只供sources页使用；放弃新增无消费者summaryAPI的初步方向，实际MediaLibrarySettingsPage以tab==='sources'控制hook.loadLatest。默认true保留潜在调用方行为；扫描监听/启停不受可见性控制。
- 禁用时切独立inactive查询key、gcTime0释放原完整数据；隐藏refresh只失效不refetch。queryFn消费signal逻辑丢弃离开/ABA/换库后的迟到结果，不是物理IPC/SQL取消。明细进入sources仍全量读取，未宣称行数/字节/在途请求有界。
- 加载、失败重试、空结果明确区分。7项真实hook/QueryClient与ScanSettingsTab定向测试通过，覆盖隐藏零读取/手工refresh/invalidate、缓存删除、再次进入、ABA/换库迟到、errorretry及三个渲染状态；未新增整页浏览器，未做新吞吐/峰值探针。详见[评估BV](large-library-source-resource-evaluation.md)。完整15/42计划继续。

- 补充红例发现旧refreshLatest闭包在hide后仍会refetch inactive observer；增加当前libraryId/loadLatest ref守卫，迟到刷新只标记旧key失效，红例恢复零新增请求。首次lint因新增.tsx测试与既有同名.test.ts冲突，改为.interaction.test.tsx后重跑，未修改项目门禁。

- 后续分页的合同核查：LibraryScanAuditPanel不仅遍历files，还把持久未识别路径去重后前置、按attention规则加入NFO候选/冲突和pendingGroups；changes按removed/promoted/deleted拼接并禁止导航已删除影片。后端分页必须保留这些合并顺序、搜索与待处理身份规则，不能只对单个JSON数组LIMIT后让前端补过滤。

- 最终全量2,370通过、1跳过、0失败（2,371项），build成功，最终7项定向重跑通过；[源码、旧闭包红例、定向/全量/构建及审查](large-library-results/implementation/batch-bv-manifest.json)6份artifact SHA256已核验。无用户数据/媒体访问、提交或推送。

## 后续批次 BW：审计后端分页方案决策探针

- 对实际UI合同核查后，先验证direct JSON分页能否避免全量成本。新增两个独立合成探针，未修改生产接口/worker配置/schema。1万/10万/30万文件、all/attention/skipped、首/末页，完整原始字段/顺序/总数对照，1次预热+3样本。
- [评估与后续实施要求](large-library-audit-pagination-evaluation.md)显示直接json_each每页解析/过滤比whole-json备选重读更慢；TEMP索引后续页快，但30万首次构建约505ms、SQLite页面分配约102MB，不能忽略初始化和容量。现有UI已缓存filtered数组，新增cached-view对照并移出事务后，明确索引不是为了胜过内存slice，whole-json不能冒充当前UI每页行为。
- 原生readonly+受控query_only切换的可行性探针通过：TEMP可构建，main写入/DDL/版本修改仍拒绝；恢复ON后TEMP只读，关闭消失，主schema/数据/版本不变。生产仍query_only=ON；后续需专属连接/受控构建及finally恢复，未在本批直接部署。
- 决策：不采用简单direct JSON分页，也不把同步TEMP构建搬到主线程。下一步按单索引/后台构建/预算/生命周期/完整UI派生合同实施；两个探针2通过、0失败，差异检查通过。无生产改动，未重复全量/build；BV生产验收保持其原有范围。完整15/42目标继续，后端分页尚未落地。

- [探针源码、最终日志、原始测量JSON及审查](large-library-results/implementation/batch-bw-manifest.json)4份artifact SHA256已核验。无用户数据/媒体访问、提交或推送。

## 后续批次 BX：只读审计原始集合索引底层模块

- 新createScanAuditReadIndex工厂使用私有native readonly连接，在同一读事务中验证源字节、schema1/2、库/run/finishedAt、五数组及原始object，再构建FILE TEMP索引。调用方必须显式提供source/index/page预算；索引page_count与返回序列化分别限制，成功query_onlyON、失败close、dispose幂等，不修改main。
- 五集合保留全部原始对象字段/ordinal，files支持outcome/attention过滤；计数小集合预聚合。页<=100，entry_bytes窄覆盖索引预检后只读取当前ordinal范围，避免第二次深OFFSET，最终包装序列化仍守字节预算。raw对象非完整业务字段校验，尚未输出最终ViewItem。
- 审查发现json_each字符串解包可误当对象，改为检查原e.type、非object插NULL触发整体失败；五section测试覆盖。9项定向含原readonly4项及模块5项，验证字段/顺序/组合筛选、字节/空间错误及恢复、包装超限、身份/版本/类型、独立结果、关闭；构建中writer提交后旧五类快照保持、新五类空。
- [实际模块评估BX](large-library-audit-pagination-evaluation.md)：30万长路径文件源87.94MB、TEMP逻辑页面137.47MB，构建1278.105ms，首100中位0.084ms、末100为4.479ms。构建一次/页预热后三样本，计时含字节检查和包装序列化；不作p95/IPC/峰值/冷盘/Windows/HDD保证。probe配置128MiB/256MiB/64KiB不是产品默认值。没有将同步工厂接入主线程。
- 未接入worker调度/IPC/UI，单活动索引、容量策略、可变未识别/待处理合并、ViewItem合同和应用生命周期仍必须完成。page_count不是总临时I/O或进程内存预算，初次构建和深OFFSET仍有成本。完整15/42目标继续。

- 最终全量2,375通过、1跳过、0失败（2,376项），build成功；[源码、9项定向/全量/构建、实际模块基准及审查](large-library-results/implementation/batch-bx-manifest.json)7份artifact SHA256已核验。无用户数据库/媒体访问、提交或推送。

## 后续批次 BY：审计索引进入共享读取线程

- CatalogReadWorkerClient新增readAuditPage，normalize在分配前验证并复制身份/query/预算，key包括完整审计操作及原context revision；复用单worker/32订阅/串行/期限/取消和终止屏障。worker新增分支，未连接实际审计IPC或页面。
- ScanAuditIndexSession单活跃索引，换snapshot/预算/source data_version/schema_version先释放后构建；所有读取失败清理，idle30s安排释放/使用重置，dispose幂等且永久拒绝后续。idle非硬截止，同步SQL可延后；全库任意提交会保守失效，未优化复用率。专属index只读连接的TEMP构建不改变tag/image连接query_only。
- 最终33项定向通过，包括原生命周期与新增session2/client2/真实worker1；覆盖混合容量/合并/复制/非法无分配/queuedabort、读写后失效与失败恢复、单活跃及空闲释放。真实worker[评估BY](large-library-audit-pagination-evaluation.md)：30万构建含启动1293.177ms，等待期间main计时器502次/maxgap13.424ms，热末页3.384–3.887ms；非p95/冷盘/IPC/UI/峰值/混合公平性保证。
- 两项边界保留：构建期间外部提交不保证返回时最新，只保证一致旧快照并在下一请求重建；强制原生终止和平台故障矩阵未完成。预算是调用参数，未确定UI产品默认。完整15/42目标继续，下一步需ViewItem/可变未识别等合同及实际IPC/UI接入。

- 最终全量2,380通过、1跳过、0失败（2,381项），build成功；[源码、33项定向/全量/构建、真实worker探针及审查](large-library-results/implementation/batch-by-manifest.json)7份artifact SHA256已核验。无用户数据库/媒体访问、提交或推送。

## 后续批次 BZ：审计读IPC与共享原始展示规则

- raw类型移至shared/scanAuditReadTypes，index保留类型reexport；新增HEADER/PAGE typedIPC、strictschema、preload及实际scanHandlers异步worker调用。IPC只接身份/query，不接受预算；主策略128MiB源/256MiB索引/1MiB页/header256KiB，超限失败不截断无同步fallback。
- worker新增header操作，source summary预检字节、原malformed/mismatchnull、audit存在flag及unrecognized COUNT在同事务，finalwrapper再守预算；不传整份audit/路径数组。header存在flag不保证正文有效，跨header/page非原子请求。超大源支持策略和实际UI未完成。
- 提取面板五pure函数和ViewItem到shared/scanAuditView并被实际面板使用，函数体AST逐字一致。旧实际函数/新共享函数分别同25测试通过，UI11原回归保持。主任务最终80定向含header3/IPC/realworker及shared/UI，验证scope、预算不可提额、坏正文不解析、WAL一致快照、错误/包装超限和展示文本。
- [评估BZ](large-library-audit-pagination-evaluation.md)记录初版预算与准确边界。既有UI仍用完整getLatest，未做新浏览器/吞吐探针，不能宣称前端大数组已移除。下一步完整合并ViewItem/搜索/动态未识别与pending状态后再切换页面，完整15/42目标继续。

- 最终全量2,410通过、1跳过、0失败（2,411项），build成功；[源码、80项定向/全量/构建、提取前oracle/函数一致性及审查](large-library-results/implementation/batch-bz-manifest.json)12份artifact SHA256已核验。controller测试仍27新增、0删除；无用户数据库/媒体访问、提交或推送。

## 后续批次 CA：组合审计视图与受限查询结果复用

- 实际面板组合items逻辑提取共享builder，旧memo离线oracle32项、共享/UI43项通过；字段、去重、顺序、NFO/待办和删除影片导航规则保持一致。底层views选项在同一构建事务复制未识别路径，以最多100条ViewItem返回完整业务视图，保留搜索locale、失败页anchor和旧badge语义。
- 复核发现初稿每页重复排名/搜索全量，已改为只保留当前筛选的一张TEMP窄匹配表；翻页按position主键读取，换条件先释放再构建。源128MiB/TEMP256MiB/page1MiB策略未提高，query_only在派生表构建后或失败时恢复，native readonly始终保护主库。
- 九项底层定向覆盖完整分页oracle、写入后的旧/新快照、anchor/字节/非法输入、搜索调用数、真实TEMP满额失败及恢复。原AP/AQ回归仍为相对HEAD增加27行、删除0行。
- 30万条真实factory合成探针：缓存前普通首页/末页249.002/279.427ms、搜索1436.525/1429.654ms；最终同条件热页1.227/1.141ms、搜索1.052/0.115ms（末页不足100项）。首次索引1631.410ms，首次普通匹配267.130ms、首次搜索700.053ms；不混淆首次与复用收益。初始TEMP206,848,000B不含后续匹配表，仍受总逻辑页配额。不是p95/冷盘/Windows/HDD/UI/IPC或内存峰值测量。
- 当前组合接口尚未接worker/session/typed IPC，实际面板仍getLatest全量持有。无audit但有未识别记录、跨请求run变更、presence/取消/查询切换、页面预算错误显示等是下一批接入要求。本批不关闭审计全量风险或完整15/42计划。

CA最终验收：`npm test` 2421通过/1跳过/0失败，`npm run build`成功；17项证据及SHA256见 `large-library-results/implementation/batch-ca-manifest.json`。完整计划继续进行。

## 后续批次 CB：组合审计worker/session/IPC

- 新getAuditViewPage已贯通preload、strict typedIPC、实际handler、共享client与真实worker。main提供固定预算，renderer无法提额；query/locale/anchor双层验证，客户端在分配worker前复制嵌套anchor、scope与预算，复用key独立于raw/header。ViewIndex复用相同query规范化。
- session维持单活跃索引，raw→views先释放再升级，views→raw复用；revision/预算/snapshot变化和失败/idle/dispose仍统一释放。共享32订阅和单执行槽未增加，无同步fallback。
- 父任务85项定向通过，覆盖新增strictIPC边界、组合页实际worker字段oracle/anchor/混用/写入重建、入队复制/取消/容量和session升级/idle/失败。两个独立只读review无未闭合阻断。
- 30万条真实worker探针启动+索引+首查询1788.417ms，主线程2ms计时器716回调/最大间隔6.447ms，末页3样本1.589/1.389/1.370ms。首次搜索使随后标签查询等待675.161ms，明确保留共享槽公平性风险，不宣称异步即可消除查询延迟。
- 实际UI尚未替换getLatest，需补有摘要但无audit正文的未识别视图和跨请求run变化，随后整体验收UI生命周期/状态/搜索/锚点/预算错误。完整15/42目标仍未完成。

CB最终验收：`npm test` 2429通过/1跳过/0失败，`npm run build`成功；6项证据及SHA256见 `large-library-results/implementation/batch-cb-manifest.json`。完整计划继续进行。

## 后续批次 CC：缺失审计正文的组合页边界

- view模式正文NULL/无row时，在同一读事务核对当前summary身份，只允许匹配后生成空raw集合+持久未识别页。ViewPage新增必填auditAvailable，区分缺失与真实空审计。原始页仍unavailable，坏JSON/结构/超限不会被静默降级。
- 58项定向通过：150唯一路径完整页oracle/重复去重/anchor/旧私有快照/新摘要拒绝/raw拒绝、损坏和超限拒绝，以及真实worker205项3页、header缺失snapshot、摘要改变拒绝旧身份、正文恢复。初始真实worker夹具补齐必需scan_run_id及其FK引用的NULL正文run，未放松约束。
- 双独立只读review无未闭合阻断。TEMP/page预算仍生效，sourceBytes只计正文；不宣称跨header/page原子、UI已切换、未识别来源总字节受sourceBytes限制或新增性能收益。
- 下一步页面可在header有summary/snapshot=null时构造view身份，并展示auditAvailable=false状态；旧摘要失效时刷新header。实际getLatest替换、presence/搜索/锚点/生命周期验收继续，完整15/42未完成。

CC最终验收：`npm test` 2432通过/1跳过/0失败，`npm run build`成功；5项证据及SHA256见 `large-library-results/implementation/batch-cc-manifest.json`。完整计划继续进行。

## 后续批次 CD：实际扫描页面远程分页

- controller改getAuditHeader及独立header key，扫描/迁移invalidations同步，隐藏页不读、gcTime0及迟到拒绝保持。每次成功header有单调revision，内容相同也刷新页。Tabs/Panel不再接收完整audit/unrecognized；生产renderer已无getLatest调用。
- Panel实际getAuditViewPage每页100，服务端total/offset/badge/anchor/availability，当前页presence保留，loading/error不显示旧页，缺失正文与真空筛选区分。搜索200ms防抖、locale显式、离开清timer；请求和session对象隔离search/library ABA，只有当前页无历史累积。retry等待header Promise与新revision观察，旧库刷新不阻塞新库。
- 修复了重复header刷新、慢anchor响应抢用户焦点，以及处理第三页定位目标消失后重复offset0/anchor导致跳首页的问题。保留实际offset并清anchor时使用捕获pageState对象相等守卫，旧行晚到不覆盖新页。
- 77项父定向通过。两尺寸×4浏览器场景全部通过，覆盖presence重试/跨页目标/搜索/延迟group状态/用户移焦；页和presence均≤100，无横向溢出/pageerror。焦点与anchor处理前后均有失败复现；原AP/AQ controller回归保持+27/-0。
- 浏览器是实际组件+合成分页API，非真实IPC或内存峰值测量；worker/IPC沿CB/CC独立测试。完整审计写入、reveal路径归属全量读、初次索引与搜索/共享槽排队、大正文保护上限及平台矩阵仍未完成。完整15/42计划继续。

CD最终验收：`npm test` 2456通过/1跳过/0失败，`npm run build`成功；13项证据及SHA256见 `large-library-results/implementation/batch-cd-manifest.json`。完整计划继续进行。

## 后续批次 CE：实际reveal异步归属校验

- SCAN_AUDIT_REVEAL_FILE已移除主线程整份审计读取。绝对路径校验后await共享worker布尔许可，成功再await fs.access后showItemInFolder原路径；失败不打开。其他功能fs.existsSync不变。
- worker优先库内normalized未识别索引；否则最近nonNULL audit、source128MiB前置、标量metadata和单entry iterator/UDF。旧6个validator函数体AST核对一致；三个路径来源全部验证，后续坏条目仍否决早命中。已知顶层重复字段明确拒绝，非任意手写JSON完全等价声明。
- 60项父定向通过，含2002次单entry JSON.parse监测、源cap前置、旧语义/库隔离/WAL替换、真实worker写入重验、32共享准入/false结果/取消、实际handler权限和access门闩。双只读review用于最终核对。
- 30万条真实worker首次572.515ms，主线程计时器232次/max3.097ms，三热次552.783/531.368/532.805ms。移出主线程且不构造完整JS对象，但仍O(N)校验/原生JSON解析、共享槽排队，不是RSS/常量耗时/p95/冷盘/平台/shell证据。
- 旧兼容全量API、审计生成/持久化、源/单条大小边界、全局队列公平性和平台/长跑矩阵继续，完整15/42目标未完成。

CE最终验收：`npm test` 2469通过/1跳过/0失败，`npm run build`成功；7项证据及SHA256见 `large-library-results/implementation/batch-ce-manifest.json`。完整计划继续进行。


## CF — 本次扫描的待确认摘要定向读取

- 实际 refreshPendingAudit 不再全库读取组和宽资源DTO再筛选；单遍收集本次 ID/全部 pending 路径，按主键选组、已有资源分组索引迭代路径，同一事务保持顺序/精确全局匹配/零组及库隔离。没有目标组则跳过查询。
- 修复 review 发现的 prepare 失败迭代器清理窗口；故障注入验证事务退出、后续写入及连接操作。36项定向通过；最终全量2478通过、1跳过、0失败（2479项），build成功；两路复核无剩余阻断。
- 5万资源10组选中场景三次热样本中位旧140.396ms→新0.301ms，全部5000组旧147.186ms→新66.655ms；四场景oracle一致。详见[审计评估CF](large-library-audit-pagination-evaluation.md)。临时合成库，不是p95/冷盘/Windows/HDD/峰值或完整扫描测量。
- 组ID/路径Set/摘要仍随本次数据量增长，选中组资源仍同步遍历；audit全量构建、finish事务内JSON.stringify和清理事务仍未闭合。完整15/42计划继续，未提交/推送/发布。
- 6项归档及SHA256见 `large-library-results/implementation/batch-cf-manifest.json`；patch为所列文件相对基线的累计差异，依赖前批。


## CG — 扫描完成根目录替换的参数上限与成员查询

- 旧40,000根ID场景实际报too many SQL variables。finishLibraryScanRun改为Set去重/成员匹配，DELETE以json_each传入根集合，固定两个参数，消除动态参数容量与O(文件数×根数)成员查找；保持原子事务和库条件，无schema变更。
- 49定向通过：参数边界、重复/空/缺省根、范围外文件、跨库根、失败/取消保留、插入失败完整回滚及重试。独立零等待writer在audit stringify期间写入成功，纠正“代码在事务内即已持有写锁”的推论，不搬移stringify冒充后台化。
- 实际3万文件完成写入探针：1/100/1000根旧中位117.480/136.988/148.065ms，新120.238/152.324/136.114ms；保留混合结果，不宣称普遍提速。源码SHA、完整结果oracle及测量限制见[审计评估CG](large-library-audit-pagination-evaluation.md)。
- 全量2488通过、1跳过、0失败（2489项），build成功，静态复核无阻断；8项证据SHA256见 `large-library-results/implementation/batch-cg-manifest.json`。既有冲突controller测试保持+27/-0。
- 剩余：实际root选择仍逐文件遍历safeRoots；大audit构建/同步JSON、整批DELETE/INSERT及清理事务未后台化。下一批索引须保留首匹配及授权规则，不能改为最长根匹配。完整15/42继续，未提交/推送/发布。


## CH — 扫描根目录匹配索引

- 实际coordinator cleanup/path-or-realPath与summary/path-only两处逐文件find已接入本轮不可变根索引，沿祖先找候选并按原predicate复核，保留原最早root对象。无授权缓存/查盘新增；失败不换根，present/missing/unknown仍走旧授权。
- 词法差分覆盖POSIX/Win32、Unicode/混合分隔符、UNC/namespace、相对根/当前盘符、父子顺序/别名/重复、根相等/..hidden、无效短路及whitespace/NUL；实际冻结快照与matcher生命周期一致。1000不相关根的relative调用从1000次减至1次。
- 10k路径1000根纯匹配三热样本中位：path-only旧7838.674ms→10.335ms，realPath旧11421.856ms→14.387ms；新构建0.228/0.389ms。每次对象身份oracle一致，固定顺序且无文件系统访问，不宣称完整扫描/p95/峰值/Windows授权验收。[完整评估](large-library-audit-pagination-evaluation.md)。
- 47项定向通过；全量2504通过、1跳过、0失败（2505项），build成功；两阶段静态复核无剩余阻断。6项证据SHA256见 `large-library-results/implementation/batch-ch-manifest.json`。旧冲突controller测试保持+27/-0。
- 索引仍随根路径总长度分配，查询随深度/字符串长度增长，特殊根fallback仍O(R)。审计全量数组/同步JSON、整批写事务与清理查盘、平台/长时间预算等仍未闭合。完整15/42计划继续，无提交/推送/发布。


## CI — 扫描尾部协作式让步

- 实际scanner尾部NFO batch/anchor审计、primary整理、audit输出已分批setImmediate。旧两项红测明确显示30次立即resolved apply/30条audit全部处理后取消回调才执行；修复后四阶段都有真实边界验证。
- NFO下一batch前检查取消，当前已提交batch的anchor审计继续；primary读取/选择/授权/写入同步完成后才让步；audit不因取消截断，末尾重新标记cancelled。原异常传播合同不变，没有跨循环持有SQLite事务/迭代器。
- 单batch30anchors测试观察部分真实anchor读取、零audit、首次callback已aborted；primary测试观察部分真实UPDATE、零audit和inTransaction=false；取消后全部已提交资源/primary/audit保留。总108定向通过，原冲突controller测试仍+27/-0。
- 全量2508通过、1跳过、0失败（2509项），build成功，两次静态复核无剩余阻断。6项证据SHA256见 `large-library-results/implementation/batch-ci-manifest.json`；[审计评估CI](large-library-audit-pagination-evaluation.md)。
- 默认yieldEvery50，NFO最多10batch一个显式让步机会；这是计数边界，不是250ms硬时限，单个NFO/SQL/文件调用仍不可抢占。未解决全量audit对象、同步JSON、批量写入/清理查盘、退出交割与平台长时矩阵。完整15/42计划继续，无提交/推送/发布。


## CJ — 分批审计存储的状态与恢复原型

- 新增[审计流式设计与验证](large-library-audit-streaming-design.md)，梳理scanner基础记录/NFO修订、coordinator数组、finish原子发布以及6类旧读入口和worker适配。明确业务提交→审计提交崩溃窗口必须另行解决。
- 未交付原型在scratch schema17数据库建prototype表；验证稳定ordinal/upsert、NFO单条修订、collecting/sealed隐藏、seal后只读、同事务发布回滚、scope/批次预算拒绝、重开恢复。没有正式schema变更或生产导入。
- 复核修复原型“patch可写但单条页超限”的预算缺口，增加完整单项包装预检；巨key页面仅投影长度预检，超限不hydrate。1048503B单项页成功。
- 两个SIGKILL时点验证已提交sealed数据保留、未提交outer publication回滚、旧已发布历史保留；官方恢复后暂存abandoned，不自动宣称完整。不是断电/COMMIT中间故障矩阵。
- 四组原型检查、定向tsc通过。10万条按100条/最大24501B输入批次生成写入；单次时耗/文件大小和局限均记录，不宣称生产提速/固定RSS或响应时限。ESLint不覆盖scripts，仅ignored警告；未重复应用全量/build，生产上一验收仍CI的2508通过/1跳过和build成功。
- 实际旧header对原型run返回空snapshot，验证双读尚未接入，不能切换生产writer。下一步按设计B–E实施；完整15/42继续。7项证据SHA256见 `large-library-results/implementation/batch-cj-manifest.json`。无提交/推送/发布。


## CK — 五处生产读取统一审计来源选择

- 新db/scanAuditSource支持exact run/latest非NULL，以及identity/bytes/body三种投影；实际header/index/pathPermission/legacy snapshot/store五处接入。原status/NULL/坏正文/旧文件fallback规则保持，后续查询仍在各reader原事务内。
- 四个selector用例覆盖scope、时间/id顺序、空/损坏/非终态、UTF8/NUL长度、SQL绑定及WAL快照。兼容repo/store补回退边界；保留原预算和校验断言。父68定向通过，冲突controller测试仍+27/-0。
- 全量2515通过、1跳过、0失败（2516项），build成功，源码与五处接线两阶段静态复核无阻断。5项证据SHA256见 `large-library-results/implementation/batch-ck-manifest.json`。
- 这是[流式设计B的第一步](large-library-audit-streaming-design.md)：统一旧来源选择，不是新格式双读已完成。JSON校验/json_each仍在原reader，schema仍17；未接入CJ原型或移除生产全量audit。bytes不返回正文给JS但可能有SQLite源页IO，未声称性能提速。完整15/42继续，无提交/推送/发布。


## CL — 正式审计条目 schema18 基础

- 独立冻结DDL由 fresh schema 和 migration18 共用；保留旧业务结构和 JSON 字节，不启动重写历史。新增 manifest/条目表约束状态、稳定身份、JSON对象和UTF-8字节数，发布后禁止修改；整run/library级联及abandoned清理保留。
- 46项定向通过：真实v17/v15结构升级、fresh18结构一致、旧数据保留、DDL执行后故障回滚与重试、外键设置恢复，以及状态/身份/终态时间/局部删除/级联。修正V14–17旧夹具的新DDL混入及后续依赖。
- 全量2527通过、1跳过、0失败（2528项），build退出0，静态复核无本批阻断；5项证据SHA256见 `large-library-results/implementation/batch-cl-manifest.json`。冲突controller测试仍+27/-0。
- 当前分支schema18；生产仍写旧audit_json。存储没有额外字节上限，不将页面限额误作数据保留上限；完整业务校验、预算、原子发布、自动中断恢复、双格式读取与扫描流式接线仍需实现。现有迁移框架的全库FK检查成本也未解决。详见[流式设计CL](large-library-audit-streaming-design.md)。完整15/42目标继续，无用户库访问、提交/推送/发布。


## CM — 正式审计双格式读取

- 统一来源选择旧JSON或新published format1+终态run；精确/最新、库范围、坏数据不退回旧run规则保持。五处生产reader沿同一来源接入，新raw/view直接SQLite复制条目到既有TEMP索引，不在JS拼全量输入。
- 新metadata保留JSON类型并校验必需字段、run/库/完成时间、重复根键和嵌入集合。复核发现并关闭布尔version/缺元字段读取分歧；文件key与正文一致。权限逐条校验且早匹配后仍检查后续条目；兼容body才重建完整审计，仍有全量内存风险。
- 84项定向通过：新旧五section/过滤/视图/锚点/header/兼容读取差分、隐藏暂存、预算拒绝、源删除后的索引快照、旧worker/IPC回归。全量2540通过、1跳过、0失败（2541项），build退出0；5项证据SHA256见 `large-library-results/implementation/batch-cm-manifest.json`。
- schema18不变，冲突controller测试仍+27/-0。新sourceBytes为存储meta+entries字节，不是重建JSON长度；全run TEMP复制与来源聚合仍O(N)，本批无提速或固定RSS声明。详见[流式设计CM](large-library-audit-streaming-design.md)。有界writer/自动恢复/原子账本/扫描Map数组移除、平台大库矩阵与完整15/42仍继续；无用户库访问、提交/推送/发布。


## CN — 同步有界审计写入与正式发布/恢复

- 新writer在调用方连接内按最多100条/1MiB批次写入，文件key覆盖保留ordinal，非files追加，NFO单条修订，meta256KiB与完整单页包装预检。嵌套savepoint可参与业务外层事务；不持有异步事务。输入仍先序列化再校验，不声称任意输入峰值固定。
- 新finish入口共用原完成事务，封存metadata字节/身份/状态检查后，run/state/未识别替换/manifest最后发布一起提交。正式启动恢复自动标记terminal暂存abandoned并保留内容，published不动，零活动run时也处理遗留。
- 56项定向通过，含实际writer→finish→读取、外层业务回滚、晚发布故障前状态观察/五表回滚/重试、恢复失败重试。全量2561通过、1跳过、0失败（2562项），build退出0；静态复核无剩余阻断。5项证据SHA256见 `large-library-results/implementation/batch-cn-manifest.json`。
- schema18不变，旧冲突controller测试仍+27/-0。生产scanner尚未使用新writer/finish；NFO需要调用方传合并后的完整字段，业务提交与审计账本窗口、全量容器、退出和平台矩阵继续推进。[流式设计CN](large-library-audit-streaming-design.md)。完整15/42仍未完成，无用户库访问、提交/推送/发布。


## CO — scanner 可选逐项持久化接收器

- 实际scanner增加同步auditSink；sink和无消费者模式不留audit Map，旧finalcallback仍保持原集合和末尾派发。NFO读取原字段、沿旧规则合并warnings、原位修订；持久化失败fatal。三个方法拒绝thenable并观察rejection。
- writer只投影单条NFO，先查字节后读，missing与缺省/null区别明确，返回值隔离。147定向通过：fresh库新旧结果/audit差分、重复path、NFO、探测挂起时独立reader见到已提交条目、取消、storage/async失败；gate测试清理缺口已修正并补跑14项+lint。
- 全量2579通过、1跳过、0失败（2580项），build退出0，复核无剩余本批阻断。7项证据SHA256见 `large-library-results/implementation/batch-co-manifest.json`。schema18不变，冲突controller测试仍+27/-0。
- 正式coordinator仍用旧finalcallback，业务与审计可能分开提交；不能仅把含await的文件循环包进同步事务。需完成同步提交段或恢复账本再启用sink，并移除coordinator数组及全量pending/cleanup依赖。[流式设计CO](large-library-audit-streaming-design.md)。完整15/42继续，无用户库访问、提交/推送/发布。


## CP — 三段 STRM 业务/审计同步事务

- sink模式的STRM目标更新（含unchanged）、重定位、invalid待确认删除与对应recordFile同事务；计数在提交后改变，索引mutate包住整个事务，进度/await不进事务。旧无sink不新增外层事务。
- 三组新真实scanner故障测试确认业务先变更、独立reader仍见旧值，再由原生审计INSERT失败触发整体回滚；重试后两类数据一起可见，验证unchanged/ordinal和失败不发完成进度。重试是新scan调用，不混称旧cache复用故障测试。
- 159定向通过；全量2582通过、1跳过、0失败（2583项），build退出0，静态复核无本批阻断。5项证据SHA256见 `large-library-results/implementation/batch-cp-manifest.json`。schema18不变，冲突controller测试仍+27/-0。
- 原子性要求内置writer同连接，不包含任意自定义sink的外部副作用；新建/待确认、本地资源、NFO与cleanup还需接入，coordinator仍旧callback。无性能收益或全流程崩溃完成声明。[流式设计CP](large-library-audit-streaming-design.md)。完整15/42继续，无用户库访问、提交/推送/发布。


## CQ — 四段本地资源业务/审计同步事务

- 时长探测后的relocation、mustConfirm入队、已有影片新资源、新影片及resource/membership与recordFile同事务。计数/newCodes/primary集合/NFO候选提交后更新；sink模式找不到新资源则回滚。旧无sink不加外层事务。
- 四组真实native审计故障前观测业务已变更、独立reader仍见旧值，失败后五表/audit恢复，重试核对计数/ID关联/ordinal/NFOapply。旧recordFile/async record失败由1影片加强为0影片。失败内部计数不可直接观测，提交后更新由代码结构支撑。
- 163定向通过；全量2586通过、1跳过、0失败（2587项），build退出0，静态复核无本批阻断。5项证据SHA256见 `large-library-results/implementation/batch-cq-manifest.json`。schema18不变，冲突controller测试仍+27/-0。
- 原子性依赖同连接同步writer；已有资源探测刷新、pending/identity、其他STRM新增、NFO与cleanup/coordinator接线仍待完成。无新性能/RSS/平台完成声明。[流式设计CQ](large-library-audit-streaming-design.md)。完整15/42继续，无用户库访问、提交/推送/发布。


## CR — 六段待确认/冲突身份业务与审计同步事务

- local/STRM各三类：番号冲突identity创建、identity刷新、existingpending resource刷新。对应upsert+recordFile同事务，计数/Set提交后更新，缓存包装整个事务；授权/stat和duration保持新增事务外。
- 六组真实审计INSERT故障测试验证业务先变更、独立reader见旧值、失败后六表/版本/audit完整恢复，再重试核对ID、字段、计数与单ordinal。169定向通过；全量2592通过、1跳过、0失败（2593项），build退出0，静态复核无本批阻断。
- 5项证据SHA256见 `large-library-results/implementation/batch-cr-manifest.json`。schema18未变，冲突controller测试仍+27/-0。证据限于同连接同步片段，没有新性能或全扫描崩溃验收声明。
- 已有本地资源探测刷新、其他STRM新增、NFO应用、cleanup/coordinator等继续实施；[流式设计CR](large-library-audit-streaming-design.md)。完整15/42未完成，无用户库访问、提交/推送/发布。


## CS — 其余 STRM 导入与已有本地资源刷新

- 三条STRM mustConfirm/已有影片新资源/新影片路径和registered local probe/backfill纳入业务+审计事务；计数/集合/NFO队列提交后更新。探测/stat在事务外，await后重新授权，invalidprobe保留旧检查。
- 新6项native故障与授权测试通过；修正mtime取整断言和gate异常清理，复核无剩余阻断。175定向通过；全量2598通过、1跳过、0失败（2599项），build退出0。
- 5项证据SHA256见 `large-library-results/implementation/batch-cs-manifest.json`。schema18不变，冲突controller测试仍+27/-0。主文件循环静态核对无剩余未接入业务写入；不覆盖NFO apply、primary收尾、cleanup和coordinator，正式流式模式仍未启用。
- 无新吞吐/RSS/平台验收声明；[流式设计CS](large-library-audit-streaming-design.md)。完整15/42继续，无用户库访问、提交/推送/发布。


## CT — NFO 导入与审计共同提交

- 普通NFO应用及待确认候选新增同步beforeCommit回调，同连接事务中修订scanner全部anchor审计；回调失败致命传播并回滚。图片暂存维持事务外，真实资产ledger清理新文件并保留旧候选；拒绝并观察异步回调。
- 提交后头像查找/旧候选清理错误只追加警告，保留已提交disposition；返回结果不变时跳过重复审计SQL。新增14测试包含真实NFO解析链、第二anchor native UPDATE故障、实际暂存资产回滚/重试。重试限于NFO事务/服务，不等同扫描重启恢复。
- 273联合测试通过；修正测试fixture类型后，全量2612通过、1跳过、0失败（2613项），build退出0，复核无本批剩余阻断。5项证据SHA256见 `large-library-results/implementation/batch-ct-manifest.json`。schema18不变，冲突controller测试仍+27/-0。
- 核心NFO结果原子提交，提交后资产诊断仍最终补写；全量anchor和预处理容器、primary/cleanup/coordinator、平台和性能矩阵继续处理。正式coordinator仍未启用sink，完整15/42未完成。[流式设计CT](large-library-audit-streaming-design.md)。无用户库访问、提交/推送/发布。


## CU — 清理业务与审计事务、补齐延迟目录清理记录

- 协调器可选同步recordCleanupAudit在原清理事务内接收缺失资源删除、清理主资源提升及无资源membership移除。启用sink时确认实际删除/提升生效；异常整体回滚，计数和legacy数组仅提交后更新。
- 延迟路径清理增加beforeCommit事件，复用现有资源/计划及每影片窄快照，检查实际修改数量。正式legacy扫描现已收录removed_library_path与promoted_after_removal逐项记录，修复过去只有数量的缺口；不记录外部目标URL。
- 新增12项真实SQLite故障/重试、异步回调拒绝、IGNORE写入、协调器事件拼接测试。95联合通过，最终全量2624通过/1跳过/0失败（2625项），构建退出0；复核发现的实际写入确认问题已修正。5项证据SHA256见 `large-library-results/implementation/batch-cu-manifest.json`。schema18不变，冲突controller仍+27/-0。
- 没有新内存/吞吐/平台完成声明。正式entries生命周期尚未接入，全量容器与长清理事务仍在，完整15/42继续。[流式设计CU](large-library-audit-streaming-design.md)。初始primary选择无需伪造清理提升审计；其写入正确性/中断恢复保留独立验收。无用户库访问、提交/推送/发布。


## CV — 从 entries 派生待确认分组并原子重建

- 新visitor验证run/library/collecting，用SQL复刻GLOBAL exact pendingPaths与引用groupIDs规则，包含无groupId路径、零计数组和原排序；不用JS files/路径/分组全集。TEMP窄快照后逐条get再回调，避免真实红测中的活动iterator与writer保存点冲突。
- writer.refreshPendingGroups在外层事务清除旧section并重建，最多100项/1MiB编码数组分批、保留其他sections；异常恢复旧内容，捕获创建时身份。ordinal按本次排序从0重排，不能作为跨刷新稳定group身份。
- 新增17测试，85联合通过；最终全量2641通过、1跳过、0失败（2642项），构建退出0，复核无本批阻断。6项证据SHA256含原生红测见 `large-library-results/implementation/batch-cv-manifest.json`。schema18不变，冲突controller仍+27/-0。
- TEMP仍占O(分组数)SQLite空间，单个大名称在writer拒绝前可能较大，没有新吞吐/RSS/平台结论。正式coordinator旧路径尚未切换；未识别结果替换、封存发布和剩余全量容器继续处理。[流式设计CV](large-library-audit-streaming-design.md)。完整15/42不完成，无用户库访问、提交/推送/发布。


## CW — 未识别文件逐项读取与发布接口

- entries finish接受同步Iterable，旧JSON finish保持array合同；在原事务内消费，失败/取消/无替换roots不枚举。新增封存files路径keyset读取器，逐条get结束查询后yield，只投影ordinal/key，捕获scope并逐次检查事务、sealed与run状态。
- 新增15测试验证真实同连接发布、顺序/最终upsert、作用域/状态、数组与生成器等值、native INSERT/晚publish故障回滚、关闭和新迭代器重试。98联合通过；修正测试spy类型后，最终全量2656通过/1跳过/0失败（2657项），build退出0，复核无阻断。5项证据SHA256见 `large-library-results/implementation/batch-cw-manifest.json`。
- 生成器一次性，重试须重新创建，不支持跨事务暂停/异步消费；目录匹配/授权/归一化仍由调用方负责，注入映射异常不等同真实FS权限矩阵验证。正式coordinator仍使用旧数组，写锁耗时/单项路径大小无新保证，完整15/42继续。[流式设计CW](large-library-audit-streaming-design.md)。schema18和冲突controller+27/-0不变，无用户库访问、提交/推送/发布。


## CX — 默认扫描正式切换流式审计

- 默认entries，begin+start原子；scanner sink、CU cleanup直写、CV pending refresh、CW未识别逐项映射、seal+finishEntries同事务贯通。停止填充完整审计Map/协调器数组，旧JSON仍读且显式json测试保留。
- 可回滚文件/NFO/cleanup错误尝试一次failed发布；终结自身错误不重复封存，降级失败保留未发布staging供启动恢复。partial结果保留已提交计数及pendingGroups，取消不替换旧未识别数据。
- 修复audit写入使STRM缓存反复重建的回归；真实20文件混合红测10次→最终1次，保留资源变化/异常失效规则。新增17测试；246联合通过，全量2673通过/1跳过/0失败（2674项），build退出0，复核无本批阻断。6项证据SHA256含红测见 `large-library-results/implementation/batch-cx-manifest.json`。
- schema18和冲突controller+27/-0未变。还需处理ScanResult/发现/预检/NFO/清理全集和同步成本，完成实际新格式大库、平台、长期及中断矩阵；不是完整15/42验收。[流式设计CX](large-library-audit-streaming-design.md)。无用户库访问、提交/推送/发布。


## CY — 无资源成员关系清理不再返回全集

- 仓储增加同步逐项回调+计数接口，TEMP固定最初候选元数据，按ID每批≤256读取后再删除/审计。默认entries coordinator采用新接口并在cleanup事务提交后更新数量，旧JSON/数组合同保留。保留原pinned/清单/当前库资源保护、共享影片和其他库成员关系；资格复查未删除不计审计。
- 新增10测试，107联合通过；全量2683通过/1跳过/0失败（2684项），构建退出0，独立静态复核无本批阻断。覆盖1030候选分页、260项coordinator审计、第202项原生审计故障与独立reader可见性、整批回滚/重试，以及元数据快照、IGNORE、异步拒绝和超长名称。6项证据SHA256见 `large-library-results/implementation/batch-cy-manifest.json`。
- 新合成探针：内存库1KiB标题，1次预热+3样本；1万22.67–23.32ms、10万304.33–356.93ms。仅checksum回调，排除真实审计写入/durable commit/FS；不能作端到端/p95或平台结论。结果已超过250ms候选同步段目标，必须继续处理线程隔离/可恢复分批，不能把行数分页当作主线程响应验收。
- 完整名称、SQLite TEMP总量、写锁时长仍无总量保证。ScanResult/发现/预检/NFO/其他清理及平台/长期/故障矩阵继续推进，完整15/42未完成。[设计与下一步](large-library-audit-streaming-design.md)。schema18未变、受保护controller仍+27/-0，无用户库访问、提交/推送/发布。


## CZ — 正式扫描完成结果不再收集或传输明细全集

- scanner显式summary模式从初始化起只有unrecognizedCount，不创建newCodes/unrecognizedFiles；默认entries接入该模式。直接scanner及rename/旧JSON保持详细结果；summary须有审计sink。coordinator所有完成返回/事件经运行时白名单投影，IPC、自动扫描、通知和前端controller使用完成摘要。
- 本地/STRM未知文件先审计成功后计数，修正持久化失败被计入partial；保留scannedFiles尝试数和原cause。processingFailures准确减去未知数及STRM失败数，仍跳过危险清理；未识别记录继续从封存entries发布。重复路径计数2、去重审计1，不从审计行数反推。
- 新增15测试，239联合通过；全量2698通过/1跳过/0失败（2699项），typecheck/build退出0，独立静态复核无本批阻断。初次类型检查发现overload可选参数与旧test helper模式不明确，已修正并复跑通过。6项证据SHA256见 `large-library-results/implementation/batch-cz-manifest.json`。
- 实际scanner夹具1/300未知文件完成JSON为297/303B，仅计数位数增长；60万仅为通知计数夹具，并非60万扫描验收。测试涵盖摘要/明细差分、native存储故障/partial、取消、已提交导入、额外属性移除、真实NFO/coordinator、前端事件/IPC去重。
- 结果不再含两个全集，但offline roots、STRM诊断及发现/预检/NFO集合仍存在；CY同步清理时延和平台/长期/中断矩阵继续。完整15/42未完成。[设计](large-library-audit-streaming-design.md)。schema18与受保护controller+27/-0不变，无用户库访问、提交/推送/发布。


## DA — NFO目录身份由完整数组改为共享摘要

- 新目录身份摘要保留数量、首个规范番号及一致性，构建一次后anchor共享不可变值，定位/资产归属判断O(1)。旧数组输入和手工目录helper保留；数组predicate直接短路判断。普通扫描按既有files累加，定向扫描按全部兄弟文件统计，重复请求不改变兄弟身份。
- 关闭NFO时跳过sidecar/身份索引；主文件循环结束后清理files、目录索引、NFO预检与newFileCounts的外层容器，排队anchors保留应用及审计必需的上下文。并未消除发现/预检此前峰值或排队NFO集合。
- 新增20测试；真实scanner red在旧数组上失败，最终177联合通过。全量2718通过/1跳过/0失败（2719项），typecheck/build退出0，独立静态复核无本批阻断。首次全量发现新增测试使用内部模块导入，已改公共入口并通过边界/7项回归，再次全量通过；未更改边界规则。
- 测试涵盖空/单未知/多未知/归一化等价/混合身份、不可变旧快照、常量字段读取、120同码分卷、真实movie.nfo/同名NFO和poster/fanart归属、定向重复目标、预处理取消与NFO关闭。取消仍无预检/导入；已提交NFO/primary/audit收尾的既有回归保留。
- 独占对照：5,000同码anchor，旧predicate403.73–406.75ms；摘要构建+逐项判断0.230–0.268ms（预热1次后3样本）。仅测身份判断，不含FS、parseCode、NFO解析/应用、audit、IPC或RSS，不宣称整个扫描加速倍数。8项证据SHA256见 `large-library-results/implementation/batch-da-manifest.json`。
- 一个规范番号仍可能很长，摘要不是固定字节上限；sidecar/readdir、手工每anchor目录读取、发现/预检/NFO峰值、CY同步清理及平台/长期/故障矩阵继续。完整15/42未完成。[设计](large-library-audit-streaming-design.md)。schema18、受保护controller+27/-0不变，无用户库访问、提交/推送/发布。


## DB — NFO采集目录复用，限制新增快照的保留量

- 默认production anchor枚举用一次成功目录读取生成身份摘要和sidecars；直接collect按library/root/词法目录复用成功索引，下一次调用重新读取。失败不缓存；显式map及身份不覆盖、不拿外部map填充其他anchor缓存。文件issue/read和root状态仍逐项验证。
- 复核发现中间无上限版本会将sidecar maps全部留在anchors，最终改为每层最多64 scopes/1MiB编码字符串，两个内部层合计最多128/2MiB这类缓存数据。计scope key、规范番号及map键值的JSON字符串UTF8字节，非整体堆上限；不包含原有调用方输入、未准入摘要和临时枚举/构建。拒绝项不缓存、不附着生产anchors、不占预算或驱逐旧项；当前数据仍完整处理。
- 新增17测试，最终108联合通过；全量2735通过/1跳过/0失败（2736项），typecheck/build退出0，独立静态复核无本批阻断。新增测试mock的implicit-any已按原方法参数类型修正，相关测试及最终全量通过。
- 实际默认适配器对照（title-only、真实catalog/root/file授权、预热1次+3样本）：100资源200次listing/32.66–34.94ms→1次/9.55–10.10ms；1,000资源2,000次/2,410.44–2,433.81ms→1次/84.13–85.58ms。最终有界版本复测，排除候选应用/全扫描、冷盘/p95/Windows/HDD/并发/RSS。
- 回归涵盖默认24资源48→1读取、首次失败3次再下次1次、新增删除NFO/兄弟身份、候选/警告等值、真实root禁用和跨scope拒绝、外部空map不污染、65 scopes与精确字节边界、超大目录回退读取且无数据遗漏。10项证据SHA256见 `large-library-results/implementation/batch-db-manifest.json`。
- 资源/anchors全集、超限目录临时峰值、其他图片搜索枚举、扫描预检/NFO队列、CY同步清理及平台/长期/故障矩阵继续，完整15/42未完成。[设计](large-library-audit-streaming-design.md)。schema18和受保护controller+27/-0未变，无用户库访问、提交/推送/发布。


## DC — 默认扫描发现清单改为 TEMP 分批存储

- summary从发现开始不再构建rootFiles/files数组；同连接TEMP表按ordinal保存重复路径和root，append每批≤256行/1MiB UTF8路径，flush后事务外让步。seal后多遍keyset读取，先窄元数据限定字节范围再投影完整路径，无活动cursor跨await/业务写入。显式detailed保留内存oracle。
- 发现/预检取消、异常与正常出口清理，NFO尾部前提前释放。symlink仅捕获stat失败，不吞存储异常。原生flush失败保留旧缓冲、失败append未接受；dispose失败可重试，双故障保持原始原因。复核发现外层事务回滚可使ordinal脱节，已对create/append/seal/dispose增加状态修改前guard及回归。
- 新增23测试，175联合通过；最终全量2758通过/1跳过/0失败（2759项），含typecheck/边界/lint/packaging，build退出0。独立静态复核确认问题关闭，无本批阻断。7项证据SHA256见 `large-library-results/implementation/batch-dc-manifest.json`；schema18不变，受保护controller仍+27/-0。
- 覆盖多页多根/重复路径与详细模式结果及审计等值、真实full/targeted发现flush取消且无导入、普通/symlink原生INSERT故障、NFO尾部anchors、目标授权失败、双重DROP故障、UTF8字节范围、关闭连接及事务回滚后重试。
- 独占探针：固定192B路径、1次预热+3样本，60万路径发现加3次完整读取，内存216.29–222.93ms、spool1372.57–1382.52ms；spool发现2343次满批flush另加seal尾批，观察到最大append约9.67ms。新增成本用于有界JS清单留存，不宣称吞吐提升。计时包含构造/逐append计时，不含FS/业务/audit/释放/事件循环让步，非整体RSS或平台验收。
- SQLite TEMP总量仍O(文件数)，预算不涵盖目录readdir/sidecars、预检/NFO队列/主资源集合和JS对象开销。持续DROP失败可残留至连接关闭。下一步处理这些全集及CY同步清理、退出交割和平台/长期/故障矩阵；完整15/42继续。[设计](large-library-audit-streaming-design.md)。无用户库访问、提交/推送/发布。


## DD/DE — NFO相关优化收尾与停止记录

- DD：summary自动合并模式完全跳过计数；保留首次业务写入前取消。其他summary用TEMP精确计数，缓冲≤256次出现/1MiB编码键，JSON+BINARY保留字符串身份，STRM逐次扣减不饱和。所有写入在主循环前完成，cached语句避免逐get/decrement重复prepare；存储失败fatal并保留cause。
- DE：summary的目录sidecar/身份、preflight及NFO队列放入扫描私有TEMP；sidecar按索引查询，读取结束后才yield，无全目录逐anchor展开。保留目录快照、路径最后非missing覆盖、冻结root、作品首次code/顺序及重复anchors；每次按作品调用原有一次apply。
- 发现并修复提交后TEMP入队的遗漏窗口：四条local/STRM新增/附加路径在同一业务/file-audit事务内enqueue，失败回滚，结果计数仅提交后更新。enqueue作为唯一变更特例可加入外层事务，序号完全由SQLite管理。取消在next前检查，不读取下一大批；已提交当前批次的审计警告继续收尾。目录/预检/应用存储异常保留cause，不降级为普通warning。
- detailed内存后端保留扫描结束后可读的真实Map快照，并消除ordinal遍历前缀重扫。工厂失败回滚DDL，全部scratch disposer独立尝试，清理错误不掩盖原始异常；新目录预算不截断业务字段或悄悄漏候选。
- 本轮新增55测试，最终245联合通过；全量2813通过/1跳过/0失败（2814项），包含边界/lint/typecheck/packaging，build退出0。首次全量仅发现两处MapIterator返回类型声明，补齐后完整重跑通过。独立最终复核无剩余本批阻断。10项artifact SHA256已验证，见 `large-library-results/implementation/batch-de-manifest.json`。schema18及受保护controller +27/-0未变。
- 回归包括精确键/边界/重复扣减、自动合并无计数器、多根计数、真实NFO多作品多anchor差分、目录变化快照、非missing覆盖、SQL读取fatal、四类资源入队原生故障/回滚/实际NFO重试、取消后零下一批读取、提交后警告及审计故障共同回滚、生命周期与真实Map兼容。
- DD独占计数探针10万不同code、3次add/1次扣减/3次get，最终TEMP1279.51–1367.67ms，memory87.78–100.07ms；旧未缓存语句迭代日志为3178.87–3508.77ms，但未独立冻结其源码。1次预热+3样本，非完整扫描、峰值、p95或目标平台；不以TEMP更慢掩盖取舍，也不把局部查询复用称作整体性能提升。
- 原始完整计划没有被缩成“已实现即完成”。已同步完整待办矩阵、读worker计划、审计流式设计、审计入口和证据索引。单作品anchors/候选、瞬时目录枚举/Map、同步目录写入和增长的TEMP仍保留；TEMP不恢复进程退出后的队列。CY长同步清理、启动/退出交割、FTS/深页/长期/平台等在待办中，本轮不再推进。用户数据未访问，代码未提交/推送/发布。
