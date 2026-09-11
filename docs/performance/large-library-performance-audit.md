# 大媒体库性能审计与优化建议（Issue #100）

2026-09-11 更新：主列表缓存窗口、大选集预览及清单/分类详情分页已按DG落实，最新结果与保留边界见[DG报告](large-library-window-selection-results.md)。以下原始风险描述保留为历史基线。

审计日期：2026-09-10。代码基线：`dev / 4c953a960d910aed3fb102b39a337b418c6292f9`，包含 PR #102 局域网 Web 端。官方 v0.6.2 不包含该 Web 端；两者不能混为同一个发布版本。本文记录该基线的审计结论；后续生产代码优化及验收进展见[实施记录](large-library-implementation-status.md)，不要把下文历史风险描述视为最新工作区状态。审计和后续合成测试均未访问用户数据库。

2026-09-11 曾按用户要求在NFO优化后停止，随后用户授权继续执行高频查询、读worker和扫描清理三项，见[DF报告](large-library-high-frequency-cleanup-results.md)。当前已实现与保留工作统一见[完整待办矩阵](large-library-optimization-plan.md#12-收尾范围与完整待办矩阵)，下文42项风险仍是原始审计基线，不因本地回归通过自动关闭。

入口：[实施计划](large-library-optimization-plan.md) · [后台处理明细](large-library-background-audit.md) · [UI/IPC 明细](large-library-ui-audit.md) · [官方资料核对](large-library-reference-research.md) · [统计维护与标签复核](large-library-statistics-probe.md) · [原始结果与复跑](large-library-results/README.md) · [基准脚本](../../scripts/performance/large-library-benchmark.ts)。

## 1. 结论与推荐决策

30 万规模的主要问题是**请求实际处理的数据量没有随页面返回量一起受限，且耗时 SQL、部分文件操作和结果转换集中在 Electron 主进程**。仅把页面 DOM 虚拟化，或统一调大 SQLite 缓存，不能消除这些阻塞。

推荐顺序：先建立测量和回归门槛；修复查询计划与不必要的全量工作；压缩/分页 IPC 数据并控制失效事件；再后台化读取、文件任务及搜索索引构建；最后用目标 Windows/HDD 环境决定缓存和 mmap 参数。每一步均保留原结果语义。

本次测得的重要结果：

- 30 万合成库已执行 ANALYZE，仍有单库目录约 **1.64 s**、全库目录约 **2.08 s**、首页约 **1.66～2.46 s**、标签计数约 **1.18 s**。返回 12/60 条不等于只处理 12/60 条。
- 同样 1 万数据，缺统计时标签聚合约 **8.50 s**，ANALYZE 后约 **28 ms**；实际 EQP 从按 `is_hidden` 扫大量成员变成按影片/媒体库定位。但单库目录在本夹具中反而从约 3.69 ms 升到 35.06 ms，**ANALYZE 也不是所有查询的单调改进**。
- 清单详情没有分页。3 万条合成影片一次返回约 **20.6 MB JSON 等价值**；这还不包括 React/IPC 的额外开销。
- 当前运行时的页缓存约 16 MB、busy timeout 5 s、WAL/NORMAL 已实际生效；#100 对“默认 2 MB / 参数缺失”的推断不适用于本次打包运行时。
- 两项隔离 SQL 实验有收益，但尚不是可直接合入的生产补丁：单库去重移除后的 count/page 分别约 284/49 ms；标签预聚合约 555 ms。还需覆盖真实数据分布与业务正确性。

## 2. 证据分层与范围

来源：[Issue #100](https://github.com/JavdexLabs/Javdex/issues/100)，用户自述 Windows x64、0.6.2、300,382 影片、约 1 GB 数据库、1,320,105 标签关系，封面在机械盘；用户还使用 DeepSeek 改过本地代码。Issue 中的优化前后数字均为**用户报告，未独立复现其环境和 diff**。维护者回复下一版本针对大库优化，不代表九条建议已经被认可。

本文使用四类标签：

- **M（测量）**：在本次隔离合成库/真实 repo 函数上跑出的数据，受机器与夹具限制。
- **C（代码）**：确认实际调用链、同步性或无界集合等特征；不虚构耗时。
- **H（待测）**：需要磁盘/并发/浏览器/用户数据分布才能判断严重程度。
- **U（用户）**：Issue 中的环境和数字。

本次覆盖主进程数据库、首页/搜索/目录/分类/清单/演员、扫描和资源治理、NFO/刮削、图片资产、启动迁移、AI/插件历史、IPC/缓存/渲染、LAN 查询与流媒体。代码审计不等于所有路径都已实测，更不能证明不存在其他性能风险。

**未覆盖实测**：Windows HDD/网络盘、真实 1 GB 库、冷操作系统缓存、50 个以上媒体库、高度倾斜的演员/标签关系、几十万图片解码、百万积压任务、长期历史增长、多个设备并发和断电恢复。相应风险及验证矩阵在实施计划中列出；不把 Mac 热运行结果写成客户体验承诺。

## 3. #100 九项建议逐项裁决

| 用户建议 | 核查结论 | 建议落地方式 |
|---|---|---|
| 1. 去掉默认 DISTINCT | **方向部分成立，根因说法过强。** legacy 默认列表本次按 add_time 索引扫描，没有顶层 DISTINCT 临时树；scoped 确有 DISTINCT 与排序临时树。固定演员 ID 和标签 ID 即使同时出现，也不因这两个复合唯一键连接自动产生重复。 | 对每种 JOIN 证明基数；count 与 ID 页分别优化，再批量补页面投影。不能只用“是否同时筛选演员和标签”决定。 |
| 2. 单库绕过 ROW_NUMBER | **代码存在机会**，`kind=all, libraryIds=[1]` 仍走排名。显式单库路径已经存在，不是所有查询都排名。 | 先归一化有效 active 库范围，单库复用快速路径；多库对候选集合去重，保留成员加入时间、首选库与资源归属。 |
| 3. FTS5 trigram | LIKE 和名称子查询确有风险；legacy 是影片侧 IN 子查询加内部相关 EXISTS，不能统称“每部影片重新执行整段演员搜索”；Web 是按影片相关演员 EXISTS。 | 先测精确番号路径、提前求演员 ID 集；再验证 trigram 索引与当前子串/大小写/通配符语义。短词、特殊符号和索引尚未 ready 时兜底。 |
| 4. 标签预聚合 | **M/C 支持优先处理**。缺统计会使相关成员查询严重放大；有统计仍遍历大量关系。 | 同时比较统计维护、正确覆盖索引、去重 members 后预聚合；先不要引入有维护成本的全量计数触发器。 |
| 5. 演员预聚合 | **M/C 支持**。现有演员分页/虚拟化已落地，但影片计数排序仍可能处理全部关系。 | 复用可见成员集合，先聚合后排序分页；状态计数分离。不要重新做已经完成的基础分页。 |
| 6. 删除日期空值前缀、加复合索引 | 前缀还处理 `''` 和纯空白，删掉会改变语义。scoped 第二排序键是 **membership_added_at**，不是 videos.add_time。 | 为实际排序设计候选索引/读模型；测试 NULL、空白、同分、升降序、跨页稳定。避免按错误的时间字段建索引。 |
| 7. 异步封面 + immutable | 同步读/解密和缩略图值得优化；已有 inspection 缓存；字节 LRU 虽已定义，却未接入 media://。路径身份约束必须保留。固定影片 ID 的图 URL 内容会变化，不适合无条件长缓存。 | 文件/解密后台化、有界缩略图缓存；图 URL 版本化或条件请求；LAN 的 no-store 应按认证与媒体响应分别设计，不全局改 public。 |
| 8. 全局关闭窗口刷新 | 配置确为 `refetchOnWindowFocus:true`，但只有 stale 活跃查询才可能刷新，TanStack v5 的默认事件基于可见性，不是每次切窗必然重查所有页面。 | 先统计实际 SQL/IPC；昂贵查询逐项关闭/延长新鲜期，保留精确失效和手动刷新，避免长期过期数据。 |
| 9. SQLite 参数套餐 | 本次 actual PRAGMA：`cache_size=-16000`、`busy_timeout=5000`、`synchronous=1`，不能当作缺省 2 MB 且没设置。 | 回读运行值/编译选项，逐参数试验。NORMAL 不是绝对耐久；mmap/MEMORY 不解决全量工作量。 |

对应源代码：[legacy 查询](../../src/main/db/videoRepo.ts#L1318)、[scoped 查询](../../src/main/db/scopedVideoCatalogRepo.ts#L67)、[名称搜索](../../src/main/db/actressSearchSql.ts)、[标签](../../src/main/db/tagRepo.ts#L18)、[演员聚合](../../src/main/db/actressRepo.ts#L345)、[Web 查询](../../src/main/web/catalog.ts#L84)、[连接初始化](../../src/main/db/database.ts)、[QueryClient](../../src/renderer/src/query/queryClient.ts)。外部行为边界见[官方参考](large-library-reference-research.md)，不以 AI 生成的 issue 根因说明替代官方文档或实测。

## 4. 基准方法与结果

使用仓库 Electron + better-sqlite3、真实初始化 schema、真实 repository 函数；合成数据结束后删除。Apple M4 / arm64 / 16 GiB，Electron 43.4.1，实际 SQLite 3.53.4。Node 的 `process.versions.sqlite` 与 better-sqlite3 不同，SQL 引擎版本以 SQL 查询为准。

夹具：1 万/300,382 影片、2 条演员关系/影片、4～5 条标签关系/影片，128 字节简介、1 个合成直连资源/影片。大库 10,000 演员、1,000 标签、1,301,655 标签关系；第二库追加三分之一影片重叠后约 414.57 MiB。没有真实媒体/图片/大量分类。清单上限为 30,000 条。

每个场景一次首次调用、三次热运行，下面为**热运行中位数（ms）**。不是 p95、不是冷启动、不是渲染耗时。部分进程时间重叠，不解读小幅差异；首次写库已影响 OS 缓存。原始 SQL、参数、EQP、返回字节及每次结束 RSS 保存在[结果目录](large-library-results/README.md)。

| 场景 | 1 万缺统计 | 1 万 ANALYZE | 30 万 ANALYZE |
|---|---:|---:|---:|
| legacy 首屏 | 0.32 | 0.34 | 3.03 |
| legacy 深页 | 13.25 | 14.52 | 498.22 |
| legacy 发行日期排序 | 19.02 | 20.34 | 553.08 |
| scoped 显式单库 | 3.69 | 35.06 | 1,640.44 |
| scoped 全库（仅一个活动库） | 39.92 | 47.29 | 2,080.97 |
| scoped all + 指定一个库 | 41.50 | 47.57 | 1,455.17 |
| scoped 番号子串搜索 | 19.10 | 15.02 | 982.98 |
| 全部标签计数 | 8,503.95 | 27.95 | 1,182.67 |
| 手工标签计数 | 8,557.28 | 33.76 | 1,443.25 |
| 演员首屏 240 条 | 3,986.41 | 13.53 | 523.69 |
| 首页单库 | 46.68 | 55.17 | 1,658.04 |
| 首页重叠双库 | 60.31 | 60.55 | 2,459.74 |
| Web 首屏 | 971.53 | 2.44 | 81.98 |
| Web 搜索 | 1,945.99 | 12.96 | 444.88 |
| Web 库/清单集合 | 908.24 | 4.53 | 37.80 |
| 清单完整详情 | 31.56 | 30.57 | 95.70 |

独立 `startup` profile 对已是 schema 15 的库重复执行 `migrateDatabase`，热中位数 **248.51 ms**，首次 250.72 ms；这只是初始化中的迁移/外键检查段，不是完整应用启动耗时。此路径使用 `db.pragma`，不经过脚本 prepare 代理，因此结果中 `sqlCalls=0` 不代表没有执行 SQL。

### 4.1 计划退化比统一调参更值得先查

未 ANALYZE 的 1 万夹具，标签相关子查询出现：

```text
SEARCH membership USING COVERING INDEX idx_library_video_memberships_recent (is_hidden=?)
```

它不是按当前 `video_id` 定位，内层可能反复遍历大量可见成员。ANALYZE 后同一查询变为：

```text
SEARCH membership USING INDEX idx_library_video_memberships_video (video_id=? AND library_id=?)
```

这解释了此夹具标签、演员及 Web 可见性查询的数量级变化。现有代码未发现定期 `PRAGMA optimize` / `ANALYZE` 维护入口；应测升级后、批量导入后和不同基数下的计划，而非仅看索引是否存在。统计维护可能改变其他计划，因此发布前需要全查询矩阵，不能在每次页面请求中执行 ANALYZE。

### 4.2 两个隔离 SQL 候选实验

同规模另一合成库、已 ANALYZE；这些是原始 SQL 变体实验，**不是完整 API 优化后的端到端时间**：

| 对照 | 基准 | 变体 | 限制 |
|---|---:|---:|---|
| 单库 repo 总调用 vs 去掉 DISTINCT 的两个 SQL | 总调用 1,422.72 ms | count 283.77 ms、page 49.13 ms | 变体不含 hydrate；只证明当前夹具结果相等，尚未跑全部筛选/隐藏/归档场景 |
| 标签计数 vs 去重成员后预聚合 | 1,175.47 ms | 555.31 ms | 含成员物化/分组成本；并不保证小库或所有分布更快 |
| legacy 默认页去重移除 | legacy 总调用 2.88 ms | count 0.05 ms、page 0.20 ms | legacy 本来不慢，不能当作修复用户 5 秒首屏的主要证据 |

因此推荐首先解决 **scoped 列表 + count + 页面投影**，而不是只改 legacy 函数。SQL 实验通过 `assert.deepEqual` 比较当前夹具的返回行；不以此替代业务测试。单库成员 count 仍约 284 ms，后续还要避免每次翻页重复精确 count。

## 5. 数据库与 LAN 风险登记

优先级用于实施顺序：P1 首批处理，P2 随后处理，P3 需要场景证据后再投入；不等同于安全漏洞级别。M/C/H 含义见第二节。

| ID / 优先级 | 触发与证据 | 工作量/影响 | 推荐优化与边界 |
|---|---|---|---|
| DB-01 / P1 / M | [scoped.list](../../src/main/db/scopedVideoCatalogRepo.ts#L365)，目录/首页/全局搜索 | count + DISTINCT 宽行 + 多个相关投影 + 排序；返回 60 条仍约秒级 | 先获取稳定 ID/成员页，再补 60 条 DTO；count 分离按过滤键缓存，统一结果快照 |
| DB-02 / P1 / M | [scopeSql](../../src/main/db/scopedVideoCatalogRepo.ts#L67)，all 范围即使只有一个库 | 排名和资源投影覆盖全部候选成员 | 有效单库归一化；多库仅对受限候选去重；保留首选库与时间语义 |
| DB-03 / P1 / M | [tagRepo](../../src/main/db/tagRepo.ts#L18)、[演员查询](../../src/main/db/actressRepo.ts#L345) | 关联数 E 增长、错误计划可能逼近反复成员扫描；分页未限制聚合 | 成员集合 + 预聚合、统计维护、覆盖索引实验；去重共享影片、保留零计数、manual origin |
| DB-04 / P1 / M | [数据库初始化](../../src/main/db/database.ts)、上述 EQP | 无统计时小库也能秒级；统计又可能改变其他计划 | 空闲维护 optimize、批量写后调度，持久采样计划/耗时；不强制 INDEXED BY 掩盖所有分布 |
| DB-05 / P1 / M | [搜索](../../src/main/db/videoRepo.ts#L1190)、[Web 搜索](../../src/main/web/catalog.ts#L84) | 中缀匹配、演员名称 normalize 和关联扫描；30 万 scoped search 约 983 ms | 精确番号优先、名称匹配预求值；FTS 建设见计划，保留匹配语义与冲突名称排除 |
| DB-06 / P2 / M | [legacy 排序分页](../../src/main/db/videoRepo.ts#L1318)、[scoped order](../../src/main/db/scopedVideoCatalogRepo.ts#L271) | 深 OFFSET 丢弃前置行；日期表达式/跨表时间阻碍索引；legacy 深页约 498 ms | 排序模型和稳定 tie-break、keyset；页码跳转保留兼容方案，不能偷偷删空白日期规则 |
| DB-07 / P1 / M | [homeDiscoveryRepo.load](../../src/main/db/homeDiscoveryRepo.ts#L274) | recent 调用带精确 count 的 list 但丢弃 total；随机候选仍用 ROW_NUMBER；单次 7 次 SQL | recent 使用 no-count 页面接口、状态快照去重、候选索引范围方案；已有 discovery_key，不应换成 ORDER BY RANDOM |
| DB-08 / P1 / M | [getPlaylistDetail](../../src/main/db/playlistRepo.ts#L153) | 无 LIMIT，清单全集宽 DTO/转换；3 万条约 20.6 MB | detail 元数据与视频页拆开；排序分页下沉，导出/选择全集由主进程流式处理 |
| DB-09 / P2 / C | [分类查询](../../src/main/services/classificationQueryService.ts#L58) | 分类列表全量；每实体计数/封面子查询，图片候选无分页 | 分类页/候选分页、概要 read model；保留已有 options LIMIT 100，不笼统判为全部无限 |
| DB-10 / P2 / C | [listYears](../../src/main/db/scopedVideoCatalogRepo.ts#L460)、[overview](../../src/main/db/overviewRepo.ts)、[库摘要](../../src/main/db/mediaLibraryRepo.ts#L142) | 每次聚合年份/状态/根目录/待处理量；重刷频率可放大 | 快照缓存与精确失效；概要与全局数量共享计算；当前 overview 单次只约 6 ms，不能把它列为已测最大热点 |
| DB-11 / P2 / C | [listByIds/listByLibrarySelections](../../src/main/db/scopedVideoCatalogRepo.ts#L383) | 全选可构造巨大 IN/VALUES 和结果集；后者每项 3 个 SQL 参数 | 有界批次/临时选择集合，稳定快照 ID；空集合与SQLite变量上限回归 |
| DB-12 / P2 / M/C | [迁移入口](../../src/main/db/migrations.ts#L1380)、[首窗顺序](../../src/main/appMain.ts#L164) | 已是 schema 15 仍每次运行全库 foreign_key_check；30 万合成库独立热测约 248.51 ms，在首窗前同步执行 | 明确必要一致性校验与启动预算，后台执行并展示进度；不能直接删校验。V11/V14 等历史重建仅升级时执行，另测升级时间/峰值空间 |
| WEB-01 / P1 / M/C | [HTTP 路由](../../src/main/web/server.ts#L403)、[catalog](../../src/main/web/catalog.ts) | Web 和桌面共用主进程同步 DB；并发设备重复 count/search/home，阻塞互相影响 | 只读查询 worker/队列、按查询键合并、TTL/修订号缓存，丢弃过期请求；认证和库可见性校验不可缓存失效 |
| WEB-02 / P2 / C/H | [server](../../src/main/web/server.ts#L191)、[images](../../src/main/web/catalog.ts#L226) | API/静态/图片均 no-store；图片每次进入详细目录/资产读取链，反复请求重复 CPU/I/O | 静态 hash 资源缓存、私有版本化图片缓存；认证 JSON 仍不可共享缓存；后续服务器请求保留授权检查；浏览器直接命中的缓存无法即时收回，严格要求重新验证时保留 no-store 或 private/no-cache |
| WEB-03 / P2 / C/H | [HTTP 流](../../src/main/web/http.ts#L77)、[server.maxConnections](../../src/main/web/server.ts#L145) | 视频已用 pipeline/Range，不整片读内存；但128连接不是HDD吞吐预算，数设备跳播会随机读 | 全局/每设备流预算、读请求调度和取消；目标机器验证带宽/磁盘队列，不盲目将流缓冲变大 |
| WEB-04 / P2 / C/H | [query integer](../../src/main/web/catalog.ts#L21)、[auth](../../src/main/web/auth.ts#L132) | page 允许很大值；有效登录请求没有目录查询成本预算；设备活动仍周期同步小文件写 | keyset/合理页界、有效用户请求排队限额；活动写可后台批量但授权新增撤销必须持久一致，不能把失败恢复修复回退 |

DB-01/02/07 的消费链为 [mediaLibraryHandlers](../../src/main/ipc/mediaLibraryHandlers.ts) → home/scoped repo；不是只有测试调用。legacy 接口仍保留，需与新 scoped 面一致维护，但优化优先级按实际页面调用决定。

## 6. 后台、资产、UI 与跨模块风险

优先级补充：

| 风险 | 证据 | 首批建议 |
|---|---|---|
| 单根超大路径数组展开 | BG-01 + [表达式复现](large-library-results/array-expansion.json)：当前Electron中10万成功、300,382/600,764抛RangeError | 先消除大实参，再做流式目录索引；这是隔离表达式验证，不是Windows整条扫描已复现 |
| 全局徽标拉完整待确认详情 | F05；Layout每3秒调用listPending，repo逐ID加载候选JSON | count/summary专用接口，不把间隔拉长当作完整修复 |
| 任务checkpoint/加密别名/workLog重复全量重写 | BG-06/08/14，累计工作可呈平方增长 | 不变targets与游标分离、增量映射/日志；保留原子恢复 |
| 演员详情/大清单/合并候选全量搬运 | F01/02/04；主列表分页无法保护旁路 | 独立分页DTO和候选搜索，避免仅在前端slice |
| 原图读取/解密阻塞，字节缓存未接线 | BG-07/F09；getCachedAsset/setCachedAsset仅有定义 | 缩略图、有界异步读取/解码和正确缓存失效 |


详细可追溯列表见[后台审计](large-library-background-audit.md)和[UI/IPC 审计](large-library-ui-audit.md)。综合要求：

- **扫描/导入/清理**：目录遍历、已知路径快照、归属/重定位匹配、批量候选载入与任务进度要分别计量。并发池只限制正在执行的任务，不一定限制已排队文件或结果数组。安全删除、离线根目录和任务取消时的保留规则不能因性能优化被省略。
- **NFO、批量刮削及 AI 工作流**：检查准备阶段是否先加载全部影片详情；逐条重复 SQL、全量结果日志和事件广播会随 N 增长。已有后台 worker、并发上限和分批文件处理应保留；任务结束汇总不能再次复制全部数据多次。
- **图片**：缓存命中、stat、密文读取/解密、图片解码、缩略图生成是不同阶段。原图 CSS 缩小不降低解码成本；LRU 有界也不保证并发在途内存有界。缓存必须包含资产修订和算法版本，并处理缺失后恢复。
- **页面与 IPC**：影片/演员已有虚拟化，问题还可能在累计加载的 pages、整清单、筛选 options、全选 ID 集和大型详情 DTO。单次DOM有界与 JS/IPC 内存有界应分别验收。
- **查询缓存/事件**：扫描每条变更造成全局失效可能重复触发首页、计数、列表、年份与标签请求。先追踪事件频率/请求合并，不以“全关刷新”代替一致性设计。
- **长时间运行**：WAL/任务历史/日志/图片资产与索引的磁盘增长、重启恢复、缓存失效及后台任务重叠均有尾部风险。不能只测空库启动或首屏。

这里不把所有 `readFileSync` 或 `.all()` 都判为缺陷：固定配置、小枚举、单实体关联、已经有硬上限的结果，风险通常低；应结合集合规模、调用线程和频率确认。

## 7. 已有能力与不可退化的正确性边界

已有能力：WAL 与外键检查；视频/演员界面的分页或虚拟网格；演员分页专项[历史基准](actress-list-pagination.md)；固定 `discovery_key` 首页发现；图像 inspection 缓存（字节 LRU 尚未接入 media://）；插件/部分任务 worker；LAN 视频 Range/pipeline、4 KB 请求体、最大连接数与密码尝试限制。它们降低部分风险，但不能直接证明当前 30 万场景合格。

所有优化必须保留：

1. 媒体库 active/archived、成员隐藏、共享影片去重、成员加入时间与资源归属；不同界面的计数口径不得被“统一缓存”错误合并。
2. 主资源按成员归属选择，不静默换备用资源；读取文件描述符与允许根目录验证不可省略。
3. 演员名称归一化、唯一归属和待解决冲突；统计/搜索索引仅是派生数据，不能通过改主表解除冲突。
4. NULL/空字符串/空白日期、评分 NULL、同值排序与深页稳定；动态数据更新后的游标/缓存行为须定义。
5. 手工元数据、清单顺序与隐藏状态的持久性；短事务不等于允许半次删除、半次合并或丢失更新。
6. 数据库升级只能正式版本化迁移；FTS/计数表构建有 ready 状态、恢复、回退与空间预算。不得让用户 AI 直接改 schema/version 验证性能。

#101 的 `actresses.main_name` 唯一约束是另一项一致性问题。大库放大遇到问题的机会，不等于“数据量大导致唯一冲突”；本报告不会将性能索引改造当作该报错的修复。

## 8. 推荐交付与待补证据

首批提交建议：**基准/可观测性 → scoped 页与count → 聚合/统计维护 → IPC分页和失效合并**。随后完成后台任务与图片流水线，再实施搜索索引、游标与参数试验。详细模块、验收目标、依赖与发布回退见[实施计划](large-library-optimization-plan.md)。

用户补充最有价值的信息：修改版 diff、官方版同库副本的操作时间、存储类型/可用空间/内存、演员/标签/资源扇出和库重叠比例。优先收集脱敏计数与计划，不要求上传完整私人媒体库。

文档和基准可作为下版本优化的设计输入。审计完成后，工作区已逐批实施部分优化；当前状态与验证证据以[实施记录](large-library-implementation-status.md)为准。整体尚未验收，未承诺具体提速倍数，工作区改动尚未提交或推送。

### 8.1 当前工作区的剩余重点

截至实施记录批次 N，单库目录、部分聚合、清单分页与窄卡片、扫描匹配及进度广播、桌面/Web 图片异步读取和缓存已有实现与定向验证。它们不代表全部风险消除，后续建议按以下顺序收敛：

1. **完成有界数据传输与内存预算。** 待确认中心概要、演员作品集、分类和候选接口继续分页；图片限制单图输入、在途与响应总字节及解码像素。现有 96MiB 缓存和请求数量上限不能代替这些预算。
2. **削减剩余同步查询并隔离慢读。** 补统计维护、概要/计数复用和多库高重叠验证，再实施有界只读 worker。重叠双库首页合成热中位数仍约 704ms，不能宣布首屏目标达成。
3. **处理长任务的累计成本和恢复。** 扫描全量路径/审计流式化；targets 与 checkpoint 游标分离，别名及 Agent 日志增量持久化。逐项重写全集的路径需验证总写入量随任务量近线性增长，并做中断恢复验证。
4. **再推进搜索、深页和目标硬件验收。** 精确番号与名称候选先行，FTS、keyset、缩略图及 LAN 公平调度按独立工作包交付；Windows SSD/HDD、冷盘、多设备和长跑验证通过后才决定缓存及 SQLite 参数默认值。

此顺序是对剩余工作的建议，不替代完整计划中的依赖、42 项风险映射和验收矩阵。既有结果均不能外推为用户原库的确定提速。
