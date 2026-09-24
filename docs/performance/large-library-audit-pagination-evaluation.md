# 扫描审计后端分页方案验证（BW）

本批只验证方案，未替换生产接口、改变reader配置或修改数据库schema。现有sources页仍全量接收审计；BV只减少隐藏页触发，不能据此关闭审计性能风险。

## 结论

暂不采用“每页直接json_each整份audit_json并过滤”的实现。当前合成数据中它既重复解析，又在筛选和深页时更慢。推荐下一步实现可重建、连接局部的审计读模型，后台一次构建后分页；必须把首次构建、容量、数据库身份、取消和释放一起实现，不能把本探针的同步TEMP构建搬到主线程。

**不要误读对照：** whole-json代表每次重新读取并解析的备选实现，不是现有UI每次翻页。当前UI已经保留filtered数组后slice，cached-view只是这一原始条目切片操作的对照，不包含首次解析、派生ViewItem、筛选、IPC或渲染。索引不可能据此被宣传为更快的内存翻页；它用于避免前端全量持有与后端重复解析。

## 方法与结果

同一Electron/SQLite运行环境；合成1万/10万/30万文件条目，路径约200字符，混合outcome和NFO warning。验证all、attention、skipped三类过滤，首页及末页，每页100。每组一次预热、3个热样本；下面为中位数。每次检查完整原始字段、筛选总数和输入顺序等于JS oracle。

TEMP表保存ordinal、原entry JSON、outcome及attention，建立两个筛选索引；构建在各方案计时前完成。SQL方案的count/page处于同一事务；cached-view最终移到事务外，仅做已有数组slice。计时包含函数和原始页解析，不包含断言/JSON序列化。原始JSON、files及过滤oracle保留在内存，不能推断进程峰值。

| 条目量 | JSON源 MB | TEMP构建 ms | TEMP页面分配 MB |
|---:|---:|---:|---:|
| 10000 | 2.717 | 13.218 | 3.260 |
| 100000 | 27.167 | 161.167 | 33.927 |
| 300000 | 81.502 | 504.674 | 102.474 |

TEMP页面分配为temp.page_count×temp.page_size，不是RSS、实际落盘量或峰值；此探针没有强制temp_store=FILE，不据此声称索引已落到磁盘。

| 30万条目筛选/页 | whole-json ms | cached-view ms | JSON分页 ms | TEMP分页 ms |
|---|---:|---:|---:|---:|
| all / offset 0 | 72.1712 | 0.0001 | 107.5996 | 1.2058 |
| all / offset 299900 | 73.3660 | 0.0001 | 258.9443 | 16.5415 |
| attention / offset 0 | 78.6989 | 0.0001 | 327.5906 | 1.4670 |
| attention / offset 145700 | 77.8305 | 0.0001 | 404.7103 | 3.2493 |
| skipped / offset 0 | 74.0957 | 0.0001 | 254.2598 | 0.8585 |
| skipped / offset 59900 | 75.4569 | 0.0001 | 275.5917 | 1.6770 |

初次索引构建明显大于一次whole-json读取；TEMP的后续页耗时不含构建，不能作为首次响应时间。顺序固定、同机热数据、原始字段简化，本探针没有覆盖完整有效业务条目、跨扫描未识别路径合并、pendingGroups/changes、本地化搜索、动态待处理状态、真实IPC、冷盘、Windows/HDD、并发、p95或长时压力。

## 只读与TEMP可行性

第二个独立探针使用生产openReadOnlyDatabaseAtPath打开合成库。query_only=ON时TEMP写入失败；仅在探针中临时OFF，连接仍readonly=true，可构建TEMP，但对main的INSERT、DELETE、CREATE TABLE和user_version修改仍被SQLite拒绝。恢复ON后可读TEMP、不可写TEMP，关闭再打开TEMP消失；主schema、版本及原数据保持。

这证明当前运行时的机制可行，不是生产授权配置已经改变。生产读取worker仍保持query_only=ON。实现时应使用专属审计连接，在受控构建区间显式切换，finally恢复，保持native readonly且拒绝任意SQL/ATTACH；不得为TEMP写入改用可写主库连接。构建失败、满额、终止和换库必须关闭连接以丢弃派生状态。

## 下一阶段具体要求

1. 定义runId/finishedAt/库身份对应的不可变审计快照及可变未识别/待处理信息的revision；不得混用新summary和旧行。
2. 拆出共享ViewItem派生合同，以现有UI为oracle。保留未识别路径去重前置、NFO attention、pendingGroups、changes拼接顺序、删除影片禁导航、搜索和跨页定位语义。
3. 后台单一构建槽与单一活动索引，先估计源大小，再约束TEMP空间、单页行数/字节和字段投影；超预算必须显式可恢复失败，不删审计、不截断业务事实、不悄悄回退主线程全量读取。
4. 构建与页读取都进入有界调度，定义取消/超时/换库/关窗/关应用释放；评估与tag/image共享worker的饥饿风险。原生SQL不可硬中断的限制必须保留。
5. 实际替换getLatest及面板明细路径，summary/count不返回原始数组。失败重试、历史变化、未识别重命名、待处理更新、路径复制/打开授权一起测试。
6. 首次构建与后续查询分别验收；加入30万混合业务数据、多库、长字段、失败/磁盘满/中断、真实IPC与DOM/缓存/资源峰值检查。未达到这些条件前，不宣称后端分页落地或整个审计内存有界。

证据与SHA256清单见[实施记录BW](large-library-results/implementation/batch-bw-manifest.json)。仅运行两个决策探针，无生产改动，不重复全量测试/build；上一批BV的全量与构建结论仅覆盖当时生产代码。

## BX：连接局部原始审计索引模块

新增 `apps/desktop/src/main/services/scanAuditReadIndex.ts`。本批实现底层原始集合读模型，**尚未接入worker、IPC、快照解析或页面**；它是同步模块，不能直接在主进程调用。五个section保留原数组ordinal和对象全部字段，支持files的outcome/attention组合过滤，返回总数、原ordinal及最多100项。

工厂独占native readonly连接，仅构建期query_only=OFF；TEMP明确FILE、cache8MiB、max_page_count按调用方显式indexBytes预算计算。成功恢复ON后返回只读handle，任何构建异常关闭连接；dispose幂等。sourceBytes先于JSON解析检查；验证schema1/2、libraryId/runId/finishedAt和五个数组类型。条目必须原始object，files的outcome必须已知；这是原始对象索引，不是完整业务字段验证或ViewItem生成。

审查发现json_each.value解包字符串的问题，现用json_each.type保证原数组中的JSON文本字符串也被整体拒绝，不能变成对象或静默丢弃。所有输入身份/预算在构建前复制，返回对象和snapshot互不共享。索引固定于构建读事务，源记录后续改变不自动更新：后续调度器必须负责当前库/运行代次失效，不能把旧handle当作最新审计。

页字节先从窄覆盖索引预检entry_bytes，再按本页首尾ordinal、相同筛选条件读取原始entry，避免第二次深OFFSET；最终JSON序列化含wrapper再次校验pageBytes。超预算返回错误，不截断字段或记录；减小limit可重试；若单条仍超预算则继续明确失败。计数使用构建时按section/outcome/attention聚合的小集合。首次OFFSET、稀疏过滤与构建仍随规模增长。

### 实际模块探针

使用专属只读连接的真实工厂，源预算128MiB、索引256MiB、单页64KiB，都是**探针配置而非已确定的产品默认值**。一次构建，页查询一次预热后3样本，下表为页中位数。构建含连接、源校验、五集合处理、索引和计数；页读取含两次字节检查及最终序列化，排除断言。字段分布不同于BW，不跨夹具比较初始化倍数。

| 条目量 | 源JSON MB | TEMP页面 MB | 构建 ms | 首100项 ms | 末100项 ms |
|---:|---:|---:|---:|---:|---:|
| 10000 | 2.914 | 4.571 | 35.751 | 0.104 | 0.176 |
| 300000 | 87.939 | 137.474 | 1278.105 | 0.084 | 4.479 |

这里的max_page_count限制TEMP数据库逻辑页面，不是进程RSS、解析器内存、临时排序/日志或总I/O峰值上限。原始oracle仍保留；不是p95、冷盘、Windows/HDD、IPC或worker响应性测量。8MiB缓存设置也不能被称为整个索引任务只占8MiB内存。

### 正确性和后续接入

新增5项模块测试，与4项原只读连接测试共9项定向：五类逐页完整原始字段/ordinal/总数、outcome与attention交叉、结果独立；源/索引页满/返回字节及包装后超限、错误参数、关闭/失败重建；schema1/2及错误身份/结构；所有section的JSON对象字符串拒绝。构建第一集合后由writer提交替换全部数组，现有索引仍保留旧五类总数及首页；新索引五类均为空，证明多集合同一读快照。未做真实磁盘满、进程强杀或动态quota注入，SQLite页上限失败不替代这些故障测试。

下一步仍需专属后台构建与单活动索引管理、预算策略、取消/换库/退出释放、原始对象的完整业务派生、可变未识别/待处理集合合并，以及实际IPC/页面替换。底层模块不是完整审计分页交付，不关闭完整15/42计划。

## BY：共享读取线程与单索引生命周期

`CatalogReadWorkerClient.readAuditPage`通过纯校验/复制函数在分配worker之前拒绝无效身份、过滤、分页与预算；操作、snapshot、query、limits及原上下文revision进入合并键。审计、tag、classification-images共用单worker、32订阅额度、串行执行槽及原超时/取消/终止屏障。没有同步主线程fallback或新增无界请求队列。

worker中的ScanAuditIndexSession最多保留一个索引。snapshot、预算、源连接data_version/schema_version变化时先dispose旧索引，再创建新索引；构建/页读取/修订读取失败清理，永久dispose拒绝后续读取。30秒未使用安排释放，后续使用重置期限；这是事件循环定时器，共享worker被同步SQL占用时会延后，不能作为硬30秒释放保证。正常port关闭释放；强制worker终止沿用原native生命周期，未补齐Windows/HDD及原生SQL中断故障矩阵。

审计索引使用独立native readonly连接，构建时的query_only切换不会影响常驻tag/image连接。任意主库提交都可能使审计索引重建，这是保守一致性策略，可能降低扫描写入期间的缓存复用率；未来应结合不可变run身份与可变待处理revision优化，不在未验证前忽略写入。本次只保证BX读事务快照，writer在构建期间提交时不承诺结果在返回时最新；后续请求会重建。

### 验证

33项定向包含原client生命周期、原真实worker与新增5项：session失败/替换前释放/单活跃/预算与revision/空闲重置/幂等dispose；三类混合准入32、相同审计合并及结果克隆、参数预算复制、非法请求零分配、队列取消；真实worker325条分页、与tag混用、writer替换审计后重建、错误后恢复。

独立真实worker探针30万长路径skipped文件：启动与构建1293.177ms，主线程2ms计时器在等待期间运行502次，含8ms尾部收集的最大间隔13.424ms；末页预热后3样本3.887/3.603/3.384ms，首页对象31,133字节。字段分布与BX/BW不同，不直接比较构建提速。测量包含worker启动、client上下文、消息与复制；不是p95、冷盘、UI、实际handler、混合公平性或峰值内存证据。全量oracle仍保留。

### 未完成的接入

预算仍由调用方显式提供，128MiB/256MiB/64KiB仅探针配置；未新增用户可调用的审计分页IPC，也未替换现有getLatest或审计页面。接下来需实现完整原始对象→业务显示规则、摘要/count、持久未识别去重合并与活跃待处理状态，再进行实际页面分页和生命周期验收。共享worker错误会沿用原失败/终止策略影响其他等待请求，慢构建也会让tag/image排队，不能声称各功能无相互影响。

## BZ：受限IPC接口与共享展示函数

新增共享读类型、SCAN_AUDIT_HEADER/PAGE、strict参数schema及preload.scan.getAuditHeader/getAuditPage，实际scanHandlers转交catalogReadService异步读取。页面不能传入预算或任意SQL；主进程策略设源128MiB、TEMP256MiB、单页1MiB、header256KiB，非法scope/过滤/页数和额外参数均拒绝。超过预算明确失败，不截断、不回退同步整份读取。该策略是新内部接口的初版保护值，超大审计的覆盖范围仍须在整体UI替换前验证；旧界面尚未改用新接口。

header在共享reader的同一事务内读取受字节限制的原summary、对应audit非NULL标记及未识别COUNT，不将audit正文或未识别路径数组返回JavaScript。摘要保留原malformed/mismatch→null规则，并在包装后再次检查字节数。snapshot仅表示对应审计存在，不证明正文合法或页请求必然成功；header/page是独立请求，不能宣称跨请求原子快照。正文有效性继续由索引构建验证。

两个header单元场景验证大/非法audit正文不被解析、库隔离/未识别计数、坏summary及源/包装超限；WAL场景在summary读取中途提交新summary和删除未识别记录，首个header仍旧三项一致，下一次看到新状态。真实worker验证header、结果克隆、非法ID及与tag共用；handler测试验证严格输入和可信固定预算，无renderer提额。

`packages/contracts/src/scanAuditView.ts`提取实际面板的fileDetail、fileView、isAttentionFile、hasNfoPendingTarget、resourceView与结构型ViewItem；实际面板改用共享函数，其余筛选/状态/分页逻辑未改。这使后续worker生成展示项可复用相同规则；本批尚未在worker中生成完整合并视图。

提取前后五个函数体经TypeScript AST逐字核对一致。同一组25项共享测试对旧实际函数及新共享函数均通过，覆盖全部outcome/updateKind/skipReason、五种NFO disposition/warnings和资源原因/空字段；原11项面板回归保留。父任务合并IPC/header/worker/共享函数与实际面板，最终80项定向通过。没有新增浏览器场景或时延基准，因为此批未改变页面布局，也未完成新分页页面链路。

剩余：持久未识别路径去重前置、跨集合changes与pendingGroups、动态状态、本地化搜索、页面锚点，以及getLatest的实际替换。不能仅用原始section页代替这些组合规则，也不能声称前端全量持有已消除。源上限128MiB等保护值对于更宽或更大审计可能拒绝读取，不能据此关闭所有大库风险。

## CA：完整组合视图与单查询派生索引

实际面板的 `items` memo 组合逻辑提取为共享 `buildScanAuditViewItems`。后端 `views:true` 构建在原始五集合的同一个读事务中复制持久未识别路径，按 normalized_path 排序、按精确 filePath 保留首条，保留旧失败页的额外未识别→attention files→pendingGroups顺序、全部outcome、changes三类顺序与删除影片禁导航、NFO状态和原行key。搜索显式接受locale，采用旧标题/详情/路径字符串的JavaScript大小写折叠及includes语义。失败页anchor保留group优先、首个匹配和页偏移；旧badge与可见失败条数存在差异的规则也保留。

新增页面默认100、最大100，原始条目字节预检及最终序列化上限仍生效。单页只派生被选中的条目；辅助查找最多随100条页大小增长。完整业务字段的运行时schema校验仍未引入，异常字段可能导致派生失败；不将对象形状校验宣称为完整业务验证。

最初实现每次count/page都执行全候选ROW_NUMBER，搜索还重复JSON.parse/fileView。复核及30万条探针确认其不适合作为最终分页路径，已改为每个索引只保留当前条件的一张TEMP匹配位置表。换条件先删除旧表，在事务中重建窄指针；同条件翻页直接按position主键范围读取，精确total复用。offset/limit/anchor不进入复用键，筛选/搜索/locale进入。构建失败不发布缓存，finally恢复query_only；native readonly始终保护main。匹配表受现有TEMP max_page_count约束，未提高256MiB默认配额。

### 测量与边界

同一实际factory的10,000/300,000长路径合成记录探针，比对每页所有ViewItem字段与共享旧逻辑oracle。30万条缓存前：all首页/末页三热样本中位249.002/279.427ms；搜索首页/末页1436.525/1429.654ms。最终实现：all首页/末页1.227/1.141ms；搜索首页/末页1.052/0.115ms（末页不足100项）。该比较衡量同条件的后续读取，不能称首次加载也降至1ms。

最终首次索引构建1631.410ms，另首次all匹配表267.130ms、failed133.520ms、skipped125.133ms、搜索700.053ms。换条件仍O(N)构建，anchor仍可能扫描匹配表。初始索引206,848,000B；`getInfo().indexBytes`是初始值，不包含后来匹配表或freelist增长，不能据此声称运行期总占用。逻辑TEMP配额也不是RSS/解析器/临时排序/总I/O上限。

仅单次构建、每页预热后3样本，oracle仍保留，计时不含断言。计时夹具无持久未识别行或资源变更，这些语义由模块测试覆盖；不是p95、冷盘、Windows/HDD、真实IPC/界面或峰值证据。页面时延含同步SQL，实际worker接入仍待下一批。

### 验证与剩余

共享/UI43项通过；同一新增组合测试对旧实际memo离线oracle32项通过，提取回调除缩进外逐字一致。底层9项覆盖所有组合规则、两种locale、搜索/页边界、anchor、写入后旧/新未识别快照、字节限制。新增UDF调用计数证明换页/页长不重复搜索；实际TEMP页满验证失败恢复只读、主库禁止写入、恢复配额后相同结果。

当前仅实际面板使用共享组合函数；worker/session/typed IPC仍只提供原始section页，尚未连通组合视图。仍需组合query复制/校验、worker单索引生命周期、getLatest实际替换、无审计但有未识别记录、header/page期间run变化、presence/取消/翻页/搜索/锚点与大审计预算错误界面验收。完整15/42目标保持进行中。

CA最终验收：`npm test` 2421通过/1跳过/0失败，`npm run build`成功；17项证据及SHA256见 `large-library-results/implementation/batch-ca-manifest.json`。完整计划继续进行。

## CB：组合视图接入共享worker与严格IPC

新增 `getAuditViewPage(snapshot,query)` 的typed IPC/preload入口，实际scanHandlers调用共享catalogReadService并传入固定可信预算。snapshot/query/anchor均严格校验，拒绝额外预算、字段或参数；locale需是有效单一语言标签。客户端入队前验证并复制所有标量与嵌套anchor；worker再次验证，ViewIndex复用相同query规范化，避免搜索locale或分页规则漂移。operation独立参与合并key，不与raw/header/tag/image结果混用。

ScanAuditIndexSession沿用单索引上限：raw→views先释放旧索引再升级；已有views索引可服务raw，不因类型交替降级重建。预算、源revision或snapshot改变仍重建，失败/idle/dispose沿统一清理。组合查询复用CA单张TEMP匹配位置表；没有另建worker、增加队列容量或同步fallback。共享worker仍最多32订阅、单执行槽；native任务执行中取消只解除订阅，物理终止与退出矩阵沿原限制。

85项父任务定向通过，新增场景包括raw/views升级与单活跃、idle/失败恢复；anchor/snapshot/预算入队后修改隔离、默认参数合并及结果克隆、与raw/header/tag共用32额度、非法query零worker分配和排队取消；真实worker325行完整组合页、group锚点、搜索与raw/tag混合、writer改动后重建、失败后恢复；strictIPC全部tab/outcome/filter、合法locale及非法边界、参数数量、预算不可提额。

独立30万条合成长路径skipped记录，真实worker启动/索引/首个组合查询1788.417ms，等待期间主线程2ms计时器716次，含8ms尾部收集的最大间隔6.447ms；末页预热后3次1.589/1.389/1.370ms，首屏序列化66,554B。首次搜索与随后排队标签查询合计675.247ms，标签等待675.161ms：异步worker避免主线程同步扫描，但慢搜索仍占共享执行槽，不构成公平性或各功能互不影响的证明。

探针只有一次启动、一次搜索/标签排队和三个热页样本；source oracle保留。不是p95、冷盘、Windows/HDD、实际handler/UI、内存峰值或原生SQL中断证据。现有页面仍getLatest全量持有；下一步必须处理有摘要无audit正文时的持久未识别记录，以及header/page之间run变化，再切换实际页面并验证presence/搜索/锚点/取消/失败重试。完整15/42计划继续。

CB最终验收：`npm test` 2429通过/1跳过/0失败，`npm run build`成功；6项证据及SHA256见 `large-library-results/implementation/batch-cb-manifest.json`。完整计划继续进行。

## CC：缺失正文时保留未识别记录

组合页现在区分真实空审计与缺失审计：返回必填 `auditAvailable`。仅当 `views:true` 且请求run没有正文（无记录或audit_json为NULL）时，底层在同一个读事务内核对当前summary的libraryId/runId/finishedAt。匹配后构建空审计集合和原有持久未识别路径索引，失败页仍按旧去重/顺序/状态分页与定位；all/changes等页为空且auditAvailable=false。无法匹配当前摘要时明确要求刷新，不能用任意不存在的run读取其他时刻的待处理状态。

原始section API继续要求正文，即使复用了缺失正文的组合索引也会报unavailable。坏JSON、正文结构/身份不符、源超限等均不触发此路径；真实正文恢复后auditAvailable=true。现有TEMP配额与最终页字节限制不变，sourceBytes仍只统计audit正文，并非未识别来源总字节限制。

58项父任务定向通过。新增底层测试在150条唯一持久路径/重复路径夹具中移除正文，完整比较两页ViewItem、badge、path anchor、其他空tab与raw拒绝；改变摘要和删除来源后，旧私有索引保持旧快照，新索引拒绝旧摘要。另一测试证明损坏/不符/超限不会被静默降级。真实worker205条跨3页，header.snapshot为null但可按summary身份读取未识别视图；writer更新summary后旧请求拒绝，新身份读取新状态；raw失败后仍可恢复，重新写入正文后返回auditAvailable=true。

这里保证单次索引构建事务内一致性，不保证header和page跨请求原子。私有索引在已有句柄上仍是旧快照；worker的下一请求沿revision失效重建。未来UI在有summary但header.snapshot=null时需以已校验summary构造view身份，并显式显示正文缺失状态；摘要更新错误应刷新header，不能循环使用旧身份重试。UI尚未接入，完整15/42计划继续。本批没有新增时延、p95、冷盘或平台测量。

CC最终验收：`npm test` 2432通过/1跳过/0失败，`npm run build`成功；5项证据及SHA256见 `large-library-results/implementation/batch-cc-manifest.json`。完整计划继续进行。

## CD：实际扫描页面切换为摘要与远程分页

`useMediaLibraryScanController`现在只调用getAuditHeader；query key改为media-library-scan-header，扫描结束及来源迁移两端的失效同步更新。隐藏页仍不读取、离开后gcTime=0，消费AbortSignal拒绝迟到结果。成功header响应附带单调递增revision，即使摘要相同也能刷新当前明细页，避免用毫秒时间戳或对象内容变化推断待处理数据是否更新。

MediaLibrarySettingsTabs到LibraryScanAuditPanel的数据链移除完整audit/unrecognized；Panel按summary身份调用getAuditViewPage，即使header.snapshot为null也能使用CC的缺失正文模式。实际渲染只保留当前最多100条服务器ViewItem，不再在renderer拼接/过滤整份审计。总数、badge、页偏移、跨页anchor和正文可用标记来自服务端。页切换或查询变化立即撤下旧行，加载、读取失败、缺失正文和真正空筛选分别显示；presence仍仅请求当前页，并保留未知/失败重试及已处理状态语义。

搜索保留浏览器locale、标题/详情/路径语义，增加200ms防抖；输入变动即隐藏旧结果，换库/卸载清定时器。request/session对象区分A→B→A，迟到响应不会进入新页面；没有历史页数组或query-cache页累积。重试先刷新header，同时等待刷新Promise完成和新revision实际到达，解决observer通知晚于refetch Promise的时序。换库不等待旧库的刷新，旧刷新成功/失败也不能覆盖新会话。处理未识别记录走一次统一header刷新，不重复调用。

### 定位和处理后的页位置

“全部文件→处理”提交path/group anchor，由服务端返回目标页，再在当前最多100行中比较精确data属性定位；路径不进入selector语法。复核与真实浏览器门闩发现，慢定位响应会抢走用户已经移到工具栏的焦点。现记录发起元素，只在当前焦点仍为发起元素或旧按钮卸载后的body/documentElement时恢复，并标记该次恢复已处理。

另一个回归测试复现：anchor请求offset=0、实际响应offset=200，处理掉该目标后重复旧anchor会跳首页。现仅当pageState仍是回调捕获对象时，将服务端实际offset写回并清anchor，再刷新；目标消失后由服务端正常clamp。旧行完成于用户切换其他页/库之后，不覆盖新pageState。

### 验收证据和限制

77项父任务定向通过，包括原展示/布局与presence回归、实际Panel分页100/100/5与字段语义、搜索防抖/搜索与库ABA、query/计时器清理、刷新失败与延迟props、旧刷新成功/失败、缺失正文、path/group焦点及用户主动移焦、处理后页位置/旧回调交错。真实controller+Panel验证old run失败后经header刷新仅请求old与next，Tabs验证summary-only及相同header的新revision触发分页读取。生产renderer检索已无getLatest调用。

Chrome实际组件浏览器夹具在1000×640和1440×900各跑4场景：scrape跨页与presence失败重试、搜索、group延迟presence定位、anchor等待中用户主动移焦，共8场景全部通过。每次presence最多100个ID、page limit100，第三页目标可见并取得正确焦点，移焦场景保持工具栏焦点，无pageerror或横向溢出。最终截图已检查。此夹具的分页API由合成数组及共享builder模拟，证明UI请求/交互而非真实IPC端到端性能；完整合成源仍存在测试环境，不作为renderer RSS证据。真实worker/IPC分别由CB/CC测试证明。

页面全量读取路径已替换，但不能据此关闭全部审计风险：SCAN_AUDIT_REVEAL_FILE仍在主线程调用readLibraryScanAudit进行路径归属检查；扫描审计构建/写入、超预算大正文支持、首次索引/搜索与共享worker排队、完整业务字段验证、平台/冷盘/故障及长时间资源验收仍待处理。完整15/42计划继续。

CD最终验收：`npm test` 2456通过/1跳过/0失败，`npm run build`成功；13项证据及SHA256见 `large-library-results/implementation/batch-cd-manifest.json`。完整计划继续进行。

## CE：显示文件位置的归属校验移到后台

实际SCAN_AUDIT_REVEAL_FILE不再在主线程调用readLibraryScanAudit/JSON.parse。注册函数仍先验证绝对本地路径，再等待共享worker的canRevealAuditPath布尔结果；未授权或校验错误不访问/打开文件。通过后使用异步fs.promises.access替换该路径的existsSync，再以原始路径调用showItemInFolder。其他功能的existsSync未在本批修改。错误保持有明确结果：无法校验归属、未授权或fileMissing，不在权限返回前提前打开目录。

worker先查当前库未识别normalized_path索引，命中直接允许，避免无关的大/坏audit影响合法未识别记录。否则按旧规则选择started_at/id倒序最近非NULL正文（不改成summary关联run）；先检查可信128MiB源预算与JSON合法性，顶层只投影所需标量和集合类型。旧6个验证函数提取为纯模块，TypeScript AST核对函数体与HEAD逐字一致，原store继续使用相同normalizeAudit。

文件、移除资源、提升资源集合用SQLite iterator逐项处理，UDF只JSON.parse单条对象，再运行原entry验证和path.resolve(...).toLowerCase()比较。即使前面路径命中，也要验证后续条目；任何无效条目拒绝整份审计。保持原audit所有平台大小写折叠，以及未识别记录的平台normalizedPath规则。已知顶层字段重复时明确拒绝歧义文档，这是对非正常JSON.stringify产物的收紧；不宣称对任意手写重复字段JSON与旧JSON.parse完全等价。

布尔请求与tag/image/header/raw/view共用已有worker和32订阅额度，独立operation key、入队前参数验证、合并与排队取消，没有增加线程或额外路径缓存。正常/失败请求只返回布尔，不把审计数组发回主进程。

### 验证及成本

60项父定向通过：旧验证和大小写路径oracle、三来源/跨库/最新nonNULL选择/不依赖summary、坏audit下未识别索引直接许可、后续无效条目否决早匹配、只读约束、读取期间WAL替换仍一致、对象字符串及重复字段拒绝。2,000文件+2资源测试监视JSON.parse，恰好2,002次且单次文本小于500字符，无完整正文解析。源预算顺序通过注入过大长度元数据、禁止进入JSON查询验证，不冒充真实128MiB磁盘故障试验。client测试覆盖false结果、混合容量和取消；真实worker覆盖布尔/标签混用及写入后重新校验；实际注册handler门闩覆盖授权/access顺序、失败及成功只打开一次。

30万条87,189,134B合成正文的真实worker探针：启动与首次权限校验572.515ms，等待期间主线程2ms计时器232次，含8ms尾部收集的最大间隔3.097ms；后续三次完整校验552.783/531.368/532.805ms。这证明校验期间主线程仍可运行，不证明校验本身变成毫秒级或常量时间。每次仍O(N)遍历三个集合，SQLite仍解析正文，单个巨型条目仍可能占较多V8内存；128MiB是源字节限制，不是总RSS/总执行时间上限。源oracle保留，一次启动与三次热读，不是p95/冷盘/平台/真实shell或网络盘测量。共享worker在约半秒校验期间仍可能让其他读请求排队。

本批闭合实际reveal的主线程整份解析路径。旧SCAN_AUDIT_GET兼容入口、审计构建/写入、首次索引/搜索及共享队列、超大/畸形数据边界和完整平台/长时间资源矩阵仍待整体评估；不关闭完整15/42计划。

CE最终验收：`npm test` 2469通过/1跳过/0失败，`npm run build`成功；7项证据及SHA256见 `large-library-results/implementation/batch-ce-manifest.json`。完整计划继续进行。


## CF：只读取本次扫描涉及的待确认摘要

`scanCoordinator.refreshPendingAudit` 单遍收集 pending 文件的组 ID 和全部原始路径，再调用 `readPendingScanAuditEntries`。不再读取该库所有待确认组及全部宽资源 DTO 后过滤。无组时直接清空摘要，不查询数据库。

新仓储在同一读事务内按所选 ID 查组，保持 `updated_at,id` 顺序；逐条读取这些组的 file_path，以原全局 Set 做精确匹配计数。保留零计数组，跨库组排除，同路径的不同资源仍逐条计数，无 groupId 的 pending 路径仍参与其他组的匹配。组 ID 通过 json_each 输入避免绑定参数数量限制，主键驱动选组，资源使用既有分组索引；没有迁移或新索引。

两个查询均先 prepare，随后才创建迭代器，避免第二个 prepare 抛错时留下未进入循环的活动迭代器。故障注入测试检查事务退出、后续写入和连接 journal_mode 操作；其他测试覆盖旧实现 oracle、宽字段不读取、选中组范围、零资源及跨库隔离、WAL 并发写下的一致快照和查询计划。

此优化缩小读取范围，并不提供固定总内存或时间上限：ID 序列化、pendingPaths 和摘要仍随本次规模增长；资源仍逐条扫描，每组选一次，全部组都涉及时仍 O(N)，在主线程同步执行。完整 audit 数组构建、finishLibraryScanRun 事务内 JSON.stringify 和清理事务长度仍待处理，不能据此关闭完整扫描写入风险或15/42计划。

### CF 独立合成测量

每组10条资源，target_locator/display_name 各512字符；1次显式预热、3次交替顺序热样本，中位耗时如下。计时含仓储调用及旧 filter/map，不含夹具、断言、序列化。

| 库资源数 | 选中组 | 旧全库 DTO 后过滤（ms） | 新定向摘要（ms） |
| --- | --- | ---: | ---: |
| 10,000 | 10 | 26.091 | 0.308 |
| 10,000 | 全部1,000 | 26.456 | 10.073 |
| 50,000 | 10 | 140.396 | 0.301 |
| 50,000 | 全部5,000 | 147.186 | 66.655 |

四场景全部与旧结果及独立顺序/计数断言一致。临时库、单库、热读且 oracle 保留；不是p95、冷盘、Windows/HDD、峰值内存、主循环延迟或完整 coordinator 端到端测量。全部组场景仍明显随规模增长，不能推断为固定预算。

CF最终验收：36项定向通过；`npm test` 2478通过/1跳过/0失败，构建成功。6项证据SHA256见 `large-library-results/implementation/batch-cf-manifest.json`。


## CG：扫描完成时的根目录筛选与事务边界复核

本轮重新审查 `finishLibraryScanRun`。其 `database.transaction(... )()` 默认使用延迟事务，当前 JSON.stringify 位于事务开始之后、第一条 SQL 之前。因此，原先“事务内序列化”描述不应直接推导出已占有 SQLite 写锁；仅把 stringify 移到函数前部，也不会消除主线程 O(正文大小) 的同步工作及完整字符串分配。CG 不以代码搬家冒充后台化，不改变序列化位置。若外层调用已经开启写事务，仍应按实际嵌套事务边界分析。

本轮针对另一条可直接验证的规模路径：替换未识别文件时，旧实现生成随根目录数增长的 DELETE 参数列表，并对每个文件执行 rootIds.includes，最坏 O(文件数×根目录数)。目标实现使用 Set 成员查询和固定两个绑定参数的 json_each 根集合删除，保持根目录去重、当前库范围和事务原子性。根集合及 JSON 仍是 O(根目录数)，不是固定总内存预算；删除与逐条插入仍在同一写事务内，同步 I/O/主循环阻塞和总事务长度仍须后续处理。


### CG 验证与测量

先运行旧实现回归，40,000 根目录 ID 触发 `too many SQL variables`（15通过、1失败）。这里仅一个为实际根，其余为不存在的安全整数 ID，用于隔离 SQL 参数边界，不冒称配置了40,000个真实目录。修改后该场景成功；新增回归覆盖重复/空/缺省根集合、范围外文件、其他库根、失败与取消不替换、重复路径插入失败后 run/state/旧记录全部回滚及重试。第二连接 busy_timeout=0 的测试在 audit stringify 时成功执行无关库写入，支持上述延迟事务边界修正；不是任意外层事务情况下的锁保证。

独立临时库中，30,000条未识别文件循环分布到真实根记录，每次替换30,000条已有记录。计时实际 finishLibraryScanRun（含 JSON、DELETE/INSERT、提交），不含构造、begin及验证。每场景一次预热、三次热样本中位：

| 根数 | 旧实现（ms） | 新实现（ms） |
| --- | ---: | ---: |
| 1 | 117.480 | 120.238 |
| 100 | 136.988 | 152.324 |
| 1,000 | 148.065 | 136.114 |

旧、新为独立进程先后测量，运行内顺序固定，不能用3个样本区分系统波动与小幅性能变化；100根场景变慢亦完整保留，不宣称普遍提速。各次验证完整 summary/audit/路径及提交状态一致，生产源码SHA随日志记录，旧SHA与基线文件一致。未测p95、冷盘、Windows/HDD、混合负载、主循环延迟或峰值。40,000边界由独立回归证明。采用本改动的确定依据是消除参数数量硬失败和线性重复成员查找；它并未关闭整批同步写入风险。


后续根目录选择优化的合同：recordSummary 仅匹配 path；cleanup 匹配 path 或 realPath，按原安全根列表首个命中返回，授权失败不能换根重试。现有 isPathUnderRoot 接受根相等，但 relative.startsWith('..') 同时拒绝首段 ..hidden；优化不顺手放宽。可评估按路径段建立本轮局部索引、保留旧 predicate 复核候选；不缓存授权结果，不新增 realpath/stat。Windows UNC/namespace、大小写、相对路径/cwd、异常短路与嵌套根顺序必须先做旧实际 find oracle。这是下一批设计，CG尚未实现。

CG最终验收：49项定向通过；全量2488通过、1跳过、0失败（2489项），构建成功。8项证据及SHA256见 `large-library-results/implementation/batch-cg-manifest.json`。


## CH：扫描根目录选择索引

`createLibraryRootMatcher` 为单轮不可变根快照建立已解析绝对路径到原 ordinal 的映射；查询沿文件的祖先目录查候选，用原 isPathUnderRoot 复核并取最早根对象。重复根/别名不改变顺序，不改成最长前缀匹配。索引仅做根选择，既有文件/根授权仍每次执行，不缓存 realpath、设备/inode 或文件状态。

summary 用 path-only matcher；cleanup 用 path-or-realPath matcher，两处保留不同合同。相对/无效根、依赖当前盘符的 Windows 根和特殊 namespace 走原 find；空根集合仍短路，不新增 whitespace/NUL 验证。默认使用原生 Node path；测试注入 path.posix/win32只验证词法语义，不冒称在Windows进行文件系统授权验收。

正常查询不再逐个访问全部根，成本随路径长度/祖先深度和候选复核增长；dirname、大小写转换及旧predicate仍处理字符串，不能宣称O(1)。构建仍O(根路径总长度)，fallback仍线性，索引不缓存文件路径结果。根数组及字段必须在matcher生命周期内保持不变；实际使用扫描快照，不能把此对象跨配置更新复用。


### CH 差分与独立测量

匹配器测试对 POSIX/Win32 path API 使用旧实际 predicate/find 作对象身份 oracle，包含父子顺序反转、重复根、早根别名、根相等、..hidden、大小写/Unicode、混合分隔符、UNC/namespace、相对路径、空/非法短路及whitespace/NUL。另有确定性工作量断言：1,000个不相关根、匹配最后一个，旧 relative调用1,000次，新候选复核1次。实际coordinator回归覆盖根顺序、summary与cleanup别名差异、present/missing授权及授权失败不尝试后续根。

10,000条合成路径，1次预热+3次热读，旧/新每次逐项比较对象身份。匹配耗时包含结果数组赋值，不含数组分配、oracle、断言、checksum或JSON；构建单独计时：

| 根数 | realPath | 旧匹配中位ms | 新匹配中位ms | 新构建中位ms |
| --- | --- | ---: | ---: | ---: |
| 1 | 关闭 | 10.063 | 8.707 | 0.014 |
| 1 | 开启 | 15.516 | 14.507 | 0.016 |
| 100 | 关闭 | 804.676 | 10.691 | 0.040 |
| 100 | 开启 | 1216.815 | 13.822 | 0.066 |
| 1,000 | 关闭 | 7838.674 | 10.335 | 0.228 |
| 1,000 | 开启 | 11421.856 | 14.387 | 0.389 |

根数升序、先path-only后realPath、先旧后新，存在固定顺序/JIT/GC影响；数据含重叠根、根相等、别名、规范化点段、未匹配兄弟路径。无用户文件/数据库访问、无实际目录授权或realpath测量。该结果为macOS原生路径热读诊断，不是p95、Windows文件系统、冷盘、内存峰值、事件循环响应或整轮扫描验收。路径索引本身仍同步执行；整体15/42风险继续。

CH最终验收：47项定向通过；全量2504通过、1跳过、0失败（2505项），构建成功。6项证据及SHA256见 `large-library-results/implementation/batch-ch-manifest.json`。


## CI：扫描尾部的协作式让步和取消

尾部 NFO apply 的 Promise 可能立即 resolve，连续 await 只切换微任务，无法保证计时器、窗口事件和取消得到执行。旧实际scanner红测：30个NFO batch全部执行后，首个apply安排的setImmediate才运行；30条审计也全部输出后，首个回调安排的setImmediate才运行。两项失败都保留为归档证据。

新实现以持续工作计数调用已有 maybeYield/setImmediate：NFO每最多min(yieldEvery,10)个batch让步，anchor审计更新每yieldEvery项（跨batch计数）；primary在单个video的读取/选择/授权/写入全部结束后让步；审计回调每yieldEvery项让步。默认yieldEvery仍50，单项工作本身不被抢占，不能据此承诺连续阻塞必定小于250ms。

取消只阻止后续NFO batch开始。已完成apply的全部anchor审计、已提交资源的主资源整理及全部文件审计仍继续，最后重新检查signal并返回cancelled；coordinator因此可跳过取消扫描的清理。没有跨循环持有数据库事务或迭代器，scan lease保持到完整流程finally。单个primary的读/选择/授权/写入之间不插入await，授权仍实时执行。

保证限于取消不截断既有收尾工作。原NFO错误转warning，primary/审计回调抛错仍向外传播；不宣称异常情况下也必定交付全审计。单个NFO apply仍无内部抢占，本批不改其文件交割或数据库原子性。原全量文件/audit对象、同步序列化、整批写入和清理查盘仍待优化。


CI实际scanner补充回归在30个不同影片立即完成NFO的场景中，验证setImmediate取消在全部apply之前到达，后续batch停止而已提交30个资源/审计/主资源保留。30条最终audit回调场景验证中途可执行取消、最终仍交付全部且返回cancelled。

单video的30个anchor测试观察实际service返回anchors的anchorPath读取，并验证取消发生在只处理部分anchors时、尚未输出audit；首次audit回调已看到abort，随后全部anchor仍带imported结果。这能区分anchor循环让步和仅在审计输出阶段让步。primary测试拦截真实UPDATE完成后安排setImmediate，观察部分primary完成、audit尚未开始及db.inTransaction=false；取消后全部30个已提交资源仍有主资源且audit完整。临时文件/SQLite夹具，非用户数据。计数与事件顺序证明四个阶段的调度边界，不是墙钟250ms、p95、8小时、退出交割或跨平台证明。

CI最终验收：108项定向通过；全量2508通过、1跳过、0失败（2509项），构建成功。6项证据及SHA256见 `large-library-results/implementation/batch-ci-manifest.json`。
