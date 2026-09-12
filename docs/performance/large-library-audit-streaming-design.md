# 扫描审计分批持久化设计与验证

状态：默认扫描已使用schema18 entries，DD预检计数与DE NFO工作集已收尾。随后用户授权的DF将生产清理改为批次事务及主循环让出，取消/失败保留已提交批次与真实计数；详见[DF报告](large-library-high-frequency-cleanup-results.md)和[ADR-0028](../adr/0028-batch-scan-cleanup-at-commit-boundaries.md)。其余完整PERF08目标保留待办。开始、逐项业务/审计、清理、待确认派生及封存发布已接通；同步成本、大库/平台及进程恢复矩阵仍未全部验收。后文早期方案与各批次文字保留为历史，最新边界见文末。

## 初始问题与边界（历史背景）

切换前，scanner 的 `auditEntriesByFile` 按原始 filePath 保存基础结果，NFO 尾部按 anchor 修订 `.nfo`，最后才调用 `onFileResult`；coordinator 又把回调收集为 `auditState.files`。只改变 finishLibraryScanRun 的 JSON 写入，或者把完整对象复制给 worker，不会消除这些全量驻留。旧 Map 的首次插入顺序与同键覆盖规则也必须保留，不能改成路径排序或按归一化路径去重。

采用按 run 暂存条目、按稳定键修订、最终原子发布的方向。原型仅操作名称含 PROTOTYPE 的临时数据库，不改变正式 schema 或生产调用。暂存数据不是已完成审计，不得被 header/page/view/路径授权作为可见历史使用。

## 存储与写接口

- manifest 关联唯一 run ID，库归属由 library_scan_runs 取得，避免重复 library_id 的跨库不一致。状态为 collecting → sealed → published；中断残留进入 abandoned，保留条目等待明确的回收策略。
- 条目主键为 run/section/ordinal；文件有原始 filePath 稳定键，同键更新保留 ordinal，其余 section 按追加顺序保存。JSON 只包含单条对象，另存 UTF-8 字节数。
- 写入批次同时限制条数和字节，生产调用必须等待刷盘完成并施加背压；禁止无界 Promise 队列。超限明确失败，不静默截断或丢弃条目。单条超限的生产处置需要预先定义，不可先做业务写入再忽略审计失败。
- NFO 修订只读取/更新对应文件条目，保留原 warning 合并规则、身份、ordinal。当前已提交 NFO batch 的全部修订必须完成；取消只阻止下一 batch。缺失 anchor 保持旧跳过语义，不能凭空新增文件结果。
- seal 之前必须排空基础条目、NFO 修订、cleanup sections 和 pendingGroups 的所有在途写入；封存后不可继续修改。发布后永久只读。

## 发布与恢复不变量

1. 发布事务同时更新审计发布标记、run终态/完成时间、summary、scan state revision/active_run_id，以及成功扫描的未识别文件替换。任一步失败整体回滚，上一份已发布历史不受影响。
2. 发布入口验证 library/run、当前running状态和sealed状态；不能只凭调用者传入runId发布其他库或已结束run。
3. 读取由同一快照中的已发布manifest和终态run确定。查询中的暂存行、已封存但未发布行均不可见。
4. 崩溃恢复先沿用官方中断run处理，再标记其暂存数据abandoned；不能把部分写入自动变成“完整审计”。清理不得涉及其他run或上一份已发布历史。
5. **业务提交与审计提交之间仍有窗口**：分批写审计本身不保证业务已提交但尚未入批的事件在崩溃后完整存在。生产接入必须选择同事务事件记录或可验证的恢复账本，不能借用原型的发布原子性宣称这个窗口已解决。
6. 文件系统动作也不因SQLite事务而自动原子；沿用已有授权/交割/恢复规则，必要时持久化操作意图与结果。

## 必须一起迁移的读入口

| 入口 | 当前依赖 | 接入要求 |
| --- | --- | --- |
| scanAuditReadHeader | audit_json非NULL判断可用 | 支持旧JSON和新已发布格式，未发布不能冒充缺省空审计 |
| scanAuditReadIndex / ViewIndex | 整份JSON预算、json_each构建TEMP | 新格式按section/ordinal读取，保留页/索引预算和业务展示顺序，不借机移除限额 |
| scanAuditPathPermission | 最新非NULL JSON及完整验证 | 按原run选择语义识别已发布格式；保留未识别路径优先及库隔离，暂存不得授予权限 |
| getLatestLibraryScanSnapshot | 按summary对应run或旧fallback组装完整audit | 兼容入口可按需重建，不能成为正常扫描或分页依赖；全量接口内存风险仍单列 |
| libraryScanAuditStore / SCAN_AUDIT_GET | DB整份JSON及未初始化时旧文件fallback | 两种存储统一适配，不得因audit_json为NULL返回假空 |
| legacyMediaLibraryBootstrap | 旧历史JSON写入 | 保留旧格式导入，不在启动同步重写全部历史 |
| catalogReadWorker / IndexSession | 已发布不可变snapshot和数据修订 | 新格式保持身份、过期缓存拒绝、预算和连接关闭合同 |

建议先引入统一来源适配层，再走正式schema迁移和双读；新writer发布与scanner/coordinator接线一起验证。不可先将新run写成audit_json=NULL而让旧读端上线。生产schema版本以实际迁移文件为准，本文不预先宣称已经升级。

## 生产接入顺序

A. 临时库验证状态机、同键修订、预算失败、跨库隔离、发布回滚、读快照和重开恢复。
B. 统一旧JSON/新条目来源适配，建立原完整audit与五个section/view/授权的差分oracle。
C. 正式schema迁移、writer有界批次与封存/发布、启动中断恢复；兼容保留旧JSON历史。
D. scanner接收器支持基础事件和NFO修订；移除其全量audit Map与coordinator全量files数组，同时替换pending摘要所需的全量集合读取。处理业务写入与审计账本的崩溃窗口。
E. 300k/600k记录的内存、最长主线程段、写批次字节/时长、并发读、退出drain、故障恢复与Windows/HDD矩阵。仅A通过不构成B–E完成。


## CJ 原型验证结果

运行：`node scripts/run-electron-tests.mjs scripts/performance/scan-audit-staging-prototype.ts`。原型代码在 `scripts/performance/prototypes/`，没有生产导入或正式schema变更，临时库用后删除。

四组验证全部通过：

- collecting/sealed不可见，同文件键覆盖保留ordinal，NFO修订保留身份；跨库、批次数量/字节超限及中途SQL失败不留下部分批次。
- publish同步事务中的run/state/未识别替换与发布标记共同回滚；外部只读连接在提交前看到旧状态、提交后看到新状态。不更新run终态或返回Promise的callback被拒绝；但异步函数自身已排队的外部副作用不在回滚保证内，生产publish必须是内部同步SQL接口。
- 临近预算上限的patch在写入前校验完整单项页包装；1,048,503B单项页成功。两条各60万字符key的页面在长度预检时拒绝，未先读入key或payload。复核发现的“能发布却无法单项读取”缺陷已在原型修正。
- 两个自行启动的子进程在发出ready消息后由父进程SIGKILL：①sealed批次已提交；②发布写入发生但外层事务未提交。等待准确退出事件后重开，3条暂存均保留，未提交发布回滚，原已发布历史保留，官方中断恢复后暂存标abandoned。integrity_check和foreign_key_check通过。

SIGKILL第二场景用外层事务和内部savepoint控制未提交时点，不是COMMIT中间随机终止、断电、磁盘满或完整生产发布故障矩阵。正常关闭重开也单独验证。业务提交与审计提交窗口、背压生产接线、总磁盘配额和abandoned回收仍未解决。

10万条记录按批生成，最大100条、24,501B输入批次；本次单次原型写入650.493ms、仅原型run标记发布0.088ms、末100条页读取4.113ms。发布计时不含真实finish的state/未识别替换，不能用于声称生产发布耗时。数据库文件31,227,904B、WAL文件4,202,432B为当时大小而非峰值。没有旧JSON对照、热样本分布、p95或RSS峰值测量；整个原型循环仍同步，生产需要有界背压及调度。OFFSET深页和inspect聚合仍随规模增长。

定向tsc包含三个原型文件及导入依赖并通过。仓库ESLint配置不覆盖scripts路径，命令只给出ignored警告，不能算lint通过；本轮未修改生产代码，未重复完整应用测试/构建，上次生产验收仍为CI的2508通过/1跳过及build成功。

实际 `readScanAuditHeader` 对已发布原型run仍返回snapshot=null的断言通过，明确暴露双读尚未接入；原型不会被当作可交付新存储格式。A完成的是这组限定状态验证，B–E仍需实施及验收。

CJ归档：7项证据及SHA256见 `large-library-results/implementation/batch-cj-manifest.json`。


## CK：生产统一选源边界（B 的第一步）

`apps/desktop/src/main/db/scanAuditSource.ts` 已由五处真实读取路径使用，统一 library/run 选择和 identity/bytes/body 三种投影。精确run与latest非NULL明确分开：有有效summary但缺正文不得退回其他run；兼容store只在DB未初始化时读旧文件。legacy JSON为空、损坏或非终态仍保留原可选中规则，随后由各reader做既有验证，不在selector悄悄过滤历史。

header仅取身份；分页索引按指定run取字节数；路径权限按最新run取字节数后在同事务校验；两个完整兼容入口按需取正文。字节数为BLOB UTF-8长度（含NUL），不把正文返回JS，但SQLite可能仍读源页，不能声称恒定I/O；body模式仍是全量兼容读取。source选择和后续查询的快照仍由caller事务保证，不新建连接或缓存。

68项定向覆盖selector、兼容repo/store、raw/view index、路径权限、真实worker和IPC。新增选择顺序/NULL/坏正文/回退/投影及WAL并发更新断言，预算和验证拒绝断言未删除。

本批仍只识别JSON格式，没有接入CJ原型表，也未修改schema。B的后续工作仍是新增格式来源与统一条目读取、差分验证；现有JSON正文校验和json_each投影仍在原reader内。不得把选源统一当作新格式双读已完成。

CK最终验收：全量2515通过、1跳过、0失败（2516项），构建成功；5项证据SHA256见 `large-library-results/implementation/batch-ck-manifest.json`。


## CL：正式 schema18 存储基础（C 的迁移部分）

新增独立、冻结的 `SCAN_AUDIT_ENTRIES_V18_SCHEMA_SQL`，由 fresh schema 和 migration18 共用，不向 migration14 的旧扫描 DDL 常量混入后续结构。新增 manifest 与 WITHOUT ROWID 条目表，历史业务表和 audit_json 不转换、不重写。版本升级依旧使用现有事务、外键检查和设置恢复机制；该框架的全库 foreign_key_check 开销仍需单独优化，本批不声称启动恒定时长。

manifest 只可在 running 且无旧 JSON 的 run 上创建。条目遵循 section/ordinal 主键、文件 key 唯一、JSON 对象、UTF-8 字节计数约束；收集期间只可改正文，不可改身份。封存后内容不可变，发布需要 run 已终结且有完成时间；发布后 run 也不可更新。直接删除仅允许 abandoned manifest，整 run/library 的级联删除保留；中断后禁止晚到写入，暂存数据可转 abandoned 后清理。

这些是存储约束，不能替代 writer 的业务字段校验、单页/批次预算及发布原子事务。正式 DDL 不沿用原型的存储字节上限：耐久保存能力与页面响应限额不是同一约束，不能在此阶段擅自缩小可保留的数据范围。业务提交与审计提交窗口仍未解决；尚未接入自动 abandoned 恢复、新 writer 或新格式 reader。

迁移验证使用实际移除新 DDL 的完整 v17 夹具，包含正常、损坏、空、NULL 旧审计和库/影片/标签关联。核对全部旧表数据、audit 原始字节以及与 fresh18 的全结构一致性；DDL 执行后注入故障，分别验证外键开启/关闭时结构、版本、数据整体回滚，再次升级成功。v15 经真实还原 cleanup 表及 tag 索引后升级也通过。较早版本测试夹具同步补齐后续迁移依赖、去除新 DDL，避免仅改 user_version 形成虚假的旧库。

46 项定向检查通过，包含收集/封存/发布/中断、身份不可变、终态与时间戳、局部删除拒绝及父级级联。静态复核无本批阻断。完整应用检查2527通过、1跳过、0失败，构建成功；5项证据SHA256见 `large-library-results/implementation/batch-cl-manifest.json`。不能把本批迁移通过视为 B–E 已完成。下一步接入双格式选源与逐条读取差分验证，再启用生产写入。


## CM：双格式读取接线

统一来源层现在识别旧非NULL JSON和新已发布format1 manifest；新格式还要求父run终态及非空finished_at。latest沿用started_at/id排序，精确run保持原scope且不因坏数据退回另一份审计。collecting/sealed/abandoned不参与选源。header使用同一来源层；旧summary缺失/坏正文等合同保留。

新条目按section/ordinal直接在SQLite中复制到既有有界TEMP索引，保留raw分页、attention/outcome计数和views排序/搜索/锚点，不先在JS组装全量audit。来源字节预算对新格式计量meta的UTF-8字节加所有entry_bytes，这是存储payload字节，不等同兼容JSON重建后的序列化长度。TEMP/page预算和最终响应包装检查仍执行；当前仍复制全run到TEMP并聚合，未证明恒定内存/构建时长，也未消除来源扫描成本。

新metadata禁止嵌入五个section、重复根键、无效必需字段或与run不符的身份/完成时间。复核发现分页曾以json_extract把布尔version当整数且缺少必需字段校验，已用保留JSON类型的窄scalar投影和normalizeAudit修正。文件entry_key与正文filePath必须一致。旧JSON分支不借机改变历史校验语义。

路径权限保持未识别文件快速通道；新格式逐条走旧validator，先命中也仍校验后续files/removed/promoted，暂存记录不得授权。兼容repo/store需要完整audit时才重建数组与JSON；迭代器避免额外保留完整raw行数组，但结果、序列化和兼容入口总体仍全量。多查询正文重建在一个事务快照内，旧文件fallback规则保持。

定向差分覆盖五section多页、全部outcome/attention、views筛选与锚点、header、两个兼容读取、已建索引在源删除后保持快照、隐藏暂存、身份/结构/预算失败。旧JSON测试与真实worker/IPC回归一起运行；本批新格式差分直接调用实际reader，并未单独声称新格式跨进程大库/性能/退出矩阵已验收。正式writer、启动abandoned恢复、业务提交与审计账本原子性和scanner全量容器移除仍待下一阶段。

CM验收：84定向通过；全量2540通过、1跳过、0失败（2541项），build退出0；复核问题已关闭。5项证据及SHA256见 `large-library-results/implementation/batch-cm-manifest.json`。


## CN：同步有界写入器与正式发布事务

新增调用方连接上的同步writer，使用SQLite嵌套事务/savepoint，使后续业务SQL与审计事件可由同一外层事务提交。每批最多100条、规范化JSON批次最多1MiB；meta最多256KiB。文件原始path作为稳定键，同键覆盖保留ordinal，其余section按追加顺序；NFO修订定位单条，缺失不新增。单条额外校验raw分页完整包装预算，预留最终finishedAt变化空间。输入对象先序列化再检查预算，不能据此声称任意输入对象的处理峰值有界。

`finishLibraryScanEntriesRun` 与原finish共用完成事务；新入口先预检meta字节，再验证封存、身份、run配置、时间及状态关系，最后在同一事务发布manifest。run终态、summary、scan-state revision和成功扫描的未识别文件替换仍原子；失败/取消仍保留此前未识别集合。旧完整JSON入口保持原签名及路径。发布入口不接收外部异步callback。

正式启动恢复沿用immediate事务，将queued/running结算为failed后，再将terminal run的collecting/sealed标为abandoned；即使没有活动run也清理终态暂存状态。仅改状态并保留条目，不影响published，不擅自删除。恢复操作失败一起回滚。

故障测试直接调用真实新finish：触发器观察run/state/新未识别记录和published标记均已更新后抛错，完整快照回滚，去掉故障再对同一sealed审计重试成功。覆盖库隔离、metadata不一致、collecting拒绝、取消/失败保留旧未识别、中断状态、已终态残留、恢复故障回滚和幂等。不是磁盘满/断电/COMMIT中间随机退出证据。

本批没有启用scanner新writer，也尚未用同事务账本串起每个业务写入点；writer具备嵌套事务能力不等于业务→审计窗口已经解决。scanner Map、coordinator数组、cleanup sections整批和旧finish仍在正常扫描路径。后续必须在逐项接线时保留NFO已有warnings合并规则、取消后已提交事件和业务/文件操作交割规则。总source/TEMP限额、累计审计保留与大库性能矩阵也继续单列。


CN定向验收：56项通过，包含writer批次/嵌套事务、正式finish和恢复、schema18与双格式回归。新writer使用100项/1MiB批次、256KiB meta、runId≤256和finishedAt≤100；NFO修改已有记录前先查字节，超限不hydrate；seal仅比较meta是否相同，不读取旧全文。重复文件顺序、中文UTF-8计数、页包装超限、格式拒绝、scope、sealed不可写均有断言。复核未发现本批剩余阻断。`patchNfo`替换完整NFO值，调用者需传入按旧规则合并好的warnings；不能直接把一份增量补丁当作最终值。

CN完整验收：2561通过、1跳过、0失败（2562项），build退出0。5项证据SHA256见 `large-library-results/implementation/batch-cn-manifest.json`。schema18未变，未访问用户库或提交/推送/发布。


## CO：实际 scanner 的可选逐项接收器

`ScanOptions.auditSink` 为调用方所有的同步recordFile/readFileNfo/patchNfo接口。提供sink时不创建audit Map，也不在扫描尾部重复派发；只用旧onFileResult时保留原Map和最终回调合同。没有两种消费者时直接省掉审计对象留存。互斥配置在扫描读取/业务写入之前拒绝。此接口没有暴露给插件或界面。

recordFile把基础条目立即写入；NFO尾部按path只读原NFO，按旧safeNfoWarnings规则合并警告，再原位修订。writer的readFileNfo在同一同步事务内预检entry_bytes，仅返回NFO；missing返回undefined，存在但NFO缺省/null返回空对象，返回值可独立修改，不返回完整file。revision时anchor丢失或存储抛错直接终止，不能变成普通processing_failure继续执行。

审查发现void方法可接受async实现；三个方法现均拒绝thenable并观察其rejection。拒绝不会等待完成，也不能撤销调用方错误async实现已经启动的副作用。这里只接受同步持久化，不允许借此跨await持有数据库事务。

147项定向检查通过，包括真实scanner使用实际writer、等价fresh库与旧callback结果对照、重复路径stableordinal、NFO原警告+apply警告合并、独立readonly连接在第二文件probe挂起时看到第一条已提交审计、probe时inTransaction=false、timercancel保留已提交记录、fatal存储失败/anchor失败、三个方法asyncresolve/reject，以及旧scanner/coordinator和发布回归。

边界：这是扫描器接收器接线，正式coordinator仍传旧finalcallback，未启用新writer发布。单文件流程有await探测，不能整段套同步事务。此次真实测试也确认业务和审计仍可能分开提交；不能把“审计及时提交”当作崩溃窗口关闭。下一步需要逐个同步业务提交段与审计事件共同事务，或正式可验证账本，再切换coordinator、pending汇总与cleanup sections，最后移除旧正常路径的数组。完整计划D/E尚未完成。

CO完整验收：2579通过、1跳过、0失败（2580项），build退出0。gate测试清理复核修正后另行14项及单文件lint通过。7项证据SHA256见 `large-library-results/implementation/batch-co-manifest.json`。schema18未变，旧冲突controller测试仍+27/-0；无用户库访问、提交/推送/发布。


## CP：三段 STRM 业务与审计共同提交

新增同步commitFileAudit边界，在配置sink时用主数据库事务包住业务SQL和recordFile。已接入三段：已有STRM目标更新（含unchanged审计）、已有STRM重定位、invalid STRM删除待确认资源及对应failure审计。修改/跳过/重定位/失败计数在事务成功返回后更新，避免审计失败仍累加成功计数。探测、进度和maybeYield保持事务外；旧无sink路径不增加外层事务。

relocation索引的mutate/mutateWithoutResourceChanges包住整个事务，因此异常走现有缓存失效路径，而非把已回滚变更留作已知写入。原子性依赖内置writer与业务使用同一SQLite连接；不能扩展到任意自定义sink的外部副作用。

三组新真实scanner测试先导入资源/建立pending，然后在审计INSERT触发器抛错前确认业务字段已变更或pending已删除。主连接看到未提交新值，独立readonly连接仍见旧值；失败后完整resource/video或pending resource/group以及audit恢复。移除触发器重试成功，另核对unchanged/skipped、stableordinal和失败进度不发布。重试是新scan调用，因此不单独声称这组测试证明旧relocation cache复用恢复；缓存异常失效另由现有单元与代码路径支撑。

159项定向通过，含scanner/sink/coordinator/relocation index/writer/publication回归。没有新吞吐/时延/RSS/HDD基准，不宣称事务改动已经带来性能收益。这三段关闭的是对应同步业务与审计提交窗口；其他STRM新增/待确认、本地资源、NFO应用、cleanup与coordinator切换仍未完成。正式coordinator继续旧回调，完整15/42目标保持。

CP完整验收：2582通过、1跳过、0失败（2583项），build退出0；静态复核无剩余本批阻断。5项证据SHA256见 `large-library-results/implementation/batch-cp-manifest.json`。schema18不变，旧冲突controller测试仍+27/-0；无用户库访问、提交/推送/发布。


## CQ：四段本地资源业务与审计共同提交

时长探测结束后的四段本地路径已接入同步commitFileAudit：资源重定位、必须确认时新增pending、已有影片插入资源、新影片及其资源/membership创建。recordFile与这些SQL共同提交；imported/relocated/skipped、pendingGroupIds、newCodes、primary选择集合和NFO候选队列的更新位于成功返回后。新影片在sink模式下若查不到刚创建的资源则抛错回滚，避免成功业务没有对应审计；旧无sink路径不加外层事务。

mustConfirm使用索引的已知非resource写包装覆盖整个事务。其他本地resource写仍由数据库revision变化使STRM缓存失效，不把可能已回滚的变化登记为有效缓存。授权和同步SQL之间没有新增await，probe/progress/yield不在事务内；同连接内置sink是原子性前提。

四组新真实测试使用native audit INSERT故障。在调用sink时先核对实际business行已新增/改变、独立连接仍见旧值，随后故障令videos/resources/memberships/pending groups/resources完整快照和审计回滚；去掉故障重试，核对分支计数、ID关联、ordinal及无关表保持。失败不发完成进度、不执行NFO apply，探测与进度观察inTransaction=false。旧recordFile及async-record失败场景改为0影片，强于先前已提交1影片的窗口证据。

163项定向通过。失败不返回ScanResult，因此测试不直接读取失败调用内部计数；计数/队列提交后更新另由代码结构支撑，nfoApplies=0不独立证明队列从未暂存，重试也为新scan实例。没有新增时延/RSS/平台/随机崩溃测量，不宣称扫描整体已提速。已有资源探测刷新、pending/identity刷新、其余STRM插入、NFO业务应用、cleanup和coordinator切换仍在完整计划内。

CQ完整验收：2586通过、1跳过、0失败（2587项），build退出0；静态复核无本批阻断。5项证据SHA256见 `large-library-results/implementation/batch-cq-manifest.json`。schema18不变，旧冲突controller测试仍+27/-0，无用户库访问、提交/推送/发布。


## CR：冲突身份和已有待确认资源的共同提交

local/STRM各三类路径完成同步事务接线：文件名与NFO番号冲突identity的新建、已有identity刷新、已有pending resource刷新。对应upsert与recordFile共同提交，pending计数和group Set在成功后更新，索引mutateWithoutResourceChanges覆盖整个事务。这些identity是资源番号冲突，不是演员名称归属。

preparePendingIdentityRefresh先读取现有待办并完成授权/stat，再返回立即调用的同步更新闭包；中间不经过await。本地pending的duration probe之后重新授权并获取fingerprint，均在新增事务之前；STRM pending的授权也放在事务外。事务里不新增进度/让步，旧无sink仍不增加外层事务。

六组真实native审计INSERT故障测试在sink中确认业务行已变化，覆盖identity创建/刷新时的ID、revision、size/mtime，及pending本地duration/指纹、STRM target。独立reader先见旧状态，失败后六表完整快照和空audit恢复；重试保留refresh原ID、create引用新ID，最终reader状态/审计/计数一致。没有完成进度或NFO apply发生在失败后。probe断言按实际路径区分，不把没有调用probe当成实际探测证据。

169项定向通过，静态复核无本批阻断。仍有原有本地资源探测刷新、其余STRM新增/入队、NFO应用、cleanup以及coordinator切换未完成；这些六条同连接同步事务的证据不代表全扫描崩溃完整性或性能验收。没有新增RSS/时延/平台基准，完整15/42继续。

CR完整验收：2592通过、1跳过、0失败（2593项），build退出0；静态复核无本批阻断。5项证据SHA256见 `large-library-results/implementation/batch-cr-manifest.json`。schema18不变，旧冲突controller测试仍+27/-0，无用户库访问、提交/推送/发布。


## CS：其余 STRM 导入与已有本地资源刷新

三条剩余STRM路径（mustConfirm、新资源加入已有影片、新影片及资源）纳入同连接同步commitFileAudit；索引mutate包含整个事务，计数/newCodes/primary集合/NFO候选提交后更新。sink模式下新影片缺资源抛错回滚，不把缺审计的创建误写为duplicate。

已有本地资源刷新改为prepareScannedFileRefresh：先stat/探测，返回同步更新闭包，调用方在await返回后立即授权并执行更新+审计事务。指纹补齐与有效duration更新都遵循此顺序，unchanged仍写skipped；无效probe保留原授权检查，不修改旧字段。没有跨probe持有SQLite事务。

本次静态核对主文件循环业务写入，未见剩余未纳入共同提交的分支。范围外仍有NFO apply/patch、primary整理、coordinator cleanup/发布切换；不能扩展为全扫描业务与审计原子性已完成。

175项定向通过。新6项包含3STRM native审计故障、2本地probe/backfill故障与重试/unchanged/invalidprobe，以及probe等待时禁用根目录后拒绝业务写入。独立reader提交前看旧值、失败完整快照恢复、重试后关联和计数正确。mtime断言采用正式statFileFingerprint的整数口径；授权gate补race与finally等待终结，避免提前退出悬挂和清理并发。复核问题均关闭。

无新增性能/RSS/平台或随机崩溃测量；旧无sink不新增外层事务，正式coordinator仍未启用sink。下一阶段继续收尾业务与审计的提交/恢复，并替换coordinator全量结构，完整15/42目标保持。

CS完整验收：2598通过、1跳过、0失败（2599项），build退出0；复核无本批阻断。5项证据SHA256见 `large-library-results/implementation/batch-cs-manifest.json`。schema18不变，旧冲突controller测试仍+27/-0；无用户库访问、提交/推送/发布。


## CT：NFO 业务提交点接入

LocalNfoScanService.apply第四个可选beforeCommit参数为同步钩子。普通应用由deliverCandidate在业务事务内、obsolete删除登记前调用；pending先在资产协调器中完成暂存，再用同步事务replace+回调。无业务写入的早退结果直接调用；不能把回调被执行当成COMMIT已成功。thenable被观察拒绝并同步报错。

scanner只在sink模式传钩子，按现有规则合并预检warnings并同步修订所有anchor。失败不降级为普通NFO警告。服务返回后保留原有让步与取消语义；结果未变不再写SQL，新增资产警告则最终补写。头像查找/旧pending资产清理异常不会改写已提交核心结果。

真实原生审计UPDATE故障、两anchor回滚、实际NFO解析/应用、真实stage文件生命周期及异步回调均有测试。273联合通过；最终全量2612通过/1跳过/0失败，构建成功。见implementation/batch-ct-manifest.json及review。初次类型门禁失败的fixture已改为真实adapter实例覆盖方法。

范围仍有限：原子性要求同步同连接writer；提交后诊断警告存在补写窗口；全部anchor仍同步遍历且保留原有全量容器，没有新RSS/吞吐/Windows数据。primary选择、cleanup审计、coordinator生产切换与封存发布仍待整合；本批不能代表PERF-08或完整15/42验收。


## CU：清理提交点与延迟目录审计

ScanCoordinatorDependencies.recordCleanupAudit(identity,event)为可选同步钩子，在原runCleanupTransaction中逐项运行。普通missing删除、删除后promotion与resource-less membership移除均覆盖；与writer同连接时审计失败回滚此前清理及pending reconciliation。计数/legacy数组只在外层成功返回后发布。默认不启用新writer。

applyPendingLibraryPathCleanups增加可选beforeCommit。删除前保留每影片标题/番号及提升资源快照，复用已有资源和plans；删除/提升实际总数与计划不同则抛错，在root/job/pending状态更新后逐项回调。没有额外全量audit DTO列表；无callback不查影片审计metadata。协调器正式旧路径现在也收集这些事件，补齐removed_library_path条目和相应promotion，来源仅本地或STRM源路径。

95联合通过；最终全量2624通过、1跳过、0失败，build退出0。新增12测试包含native第二条INSERT失败、完整回滚/重试、独立reader、无假计数/legacy条目、resolved/rejected回调以及IGNORE写入。证据见large-library-results/implementation/batch-cu-manifest.json。

### 计划判断：初始主资源选择与审计合同

无需为scanner末尾初始主资源选择新增清理事件：现有file audit不含is_primary，选择主资源不使文件导入事实失真；promoted_after_removal只描述删除后的替补提升，不能复用来记录初始选择。撤除“必须给每个业务写入增加审计事件”的推断前置条件，保留主资源事务自身正确性和资源提交后/尾部选择前中断的恢复验证。该判断不表示恢复已完成，后续总验收中列出供用户复核。

剩余：coordinator按run启动writer并采用scanner sink、pendingGroups从entries推导、cleanup不再保留返回数组、summary封存与finishEntries发布、取消/失败恢复路径。当前仍有全量资源枚举/分组/legacy数组、同步FS及长事务；没有新的有界内存、吞吐、Windows或整体PERF-08完成证据。

### 下一阶段接入顺序（静态复核，尚未实施）

1. run的beginRun与writer.start使用同连接事务；成功后传scanner auditSink，去掉files全集，writer不关闭共享连接。
2. cleanup回调直写writer，entries模式去掉missing/deferred审计数组和提交后push；membership全集返回另改流式接口。
3. pendingGroups从当前run最终files entries关联当前pending表派生，保留库/路径/排序语义；采取终结前一次写入或事务重建，不能多次append产生重复。
4. recordSummary只构造summary+metadata，统一finishedAt，在同一事务seal+finishEntries，发布失败可回滚封存状态。
5. unrecognized从entries/暂存表有界读取替换，保留safe-root匹配、授权、路径归一化；与发布同事务，失败/取消不替换旧记录，移除result路径数组及flatMap DTO依赖。
6. 验证start/审计/pending/seal/publish故障与取消，区分发布失败审计和保留未发布暂存恢复；不回退JSON，不在catch盲目再次seal。scanner其他结果数组/NFO anchors仍须继续处理。


## CV：派生 pendingGroups 的数据库接口

visitPendingScanAuditEntriesForRun(db,scope,visit)在同步事务中校验归属与running/collecting；SQL从最终files取引用group IDs，按全部pending entry_key匹配各组资源，保留无group路径、大小写精确性、零计数与updated_at/id排序。使用原文件key索引，不向JS返回full entry_json或resource DTO。

原始iterate→writeBatch嵌套事务被真实Electron/SQLite测试证明会报connection busy。最终使用事务内TEMP窄结果快照，按ordinal逐条get结束查询后再回调。成功DROP，失败事务回滚清除，回调更新pending源表不会污染已生成快照。

writer.refreshPendingGroups外层事务先删旧section，visitor输出按100项/1MiB编码数组缓冲写入，末批flush仍在同一外层事务；任何SQL/校验/字节失败恢复原section及调用方外层业务。超大单项不截断，交由既有writer页预算拒绝；scope使用创建时捕获值。重建ordinal连续，但随当前排序变化，不是group持久身份。

新增17测试覆盖原生故障/恢复、差分语义、SQL窄投影与索引、生命周期、TEMP清理、实际嵌套writer、207项与大字段字节分批。85联合通过；最终全量2641通过/1跳过/0失败，build退出0。证据见large-library-results/implementation/batch-cv-manifest.json。

这不是整体内存上限证明：SQL仍扫描本run files，TEMP及排序空间随分组数增长，单个normalizedCode在拒绝前仍可能较大。正式coordinator接入终结前refresh、未识别文件替换、seal+finish事务及取消/失败恢复仍待推进。


## CW：未识别文件的惰性发布合同

FinishLibraryScanEntriesInput.unrecognizedFiles可为同步Iterable，legacy finish仍readonly数组。现有for-of保持在完成事务中，不展开输入，仍按替换root集合过滤并严格INSERT。失败/取消/空root集合不消费，原未识别记录保留。中途next/map/insert或最后manifest publish失败均回滚run/state/未识别替换和发布状态。

iterateScanAuditUnrecognizedPaths捕获创建时libraryId/runId，首次及后续next验证当前存在事务、归属、manifest sealed及run running/completed。finish在枚举前已写completed，故允许这个发布前状态；failed/cancelled/abandoned/来源删除均拒绝。读取只取ordinal/entry_key，ordinal>last的单条get完成后yield，正确跳过过滤间隙，没有活动SQLite iterator或全文件数组。

每次重试必须新建生成器；不能复用已耗尽/关闭对象，否则会得到空输入。禁止跨事务暂停/异步消费，inTransaction本身不能证明是同一事务。helper不匹配目录、不授权、不归一化；coordinator接入时保留原safeRoots首匹配和授权规则。单项路径字节、同步循环耗时与写锁时间仍需专项测量，不能据此宣称有界延迟。

15新增测试，98联合通过；最终全量2656通过/1跳过/0失败，build退出0。见large-library-results/implementation/batch-cw-manifest.json。首次类型门禁发现test spy重载参数展开问题，仅测试改Reflect.apply后复跑成功。

下一步可将begin+start、scanner sink、CV pending refresh、CU cleanup、CW未识别迭代、seal+finishEntries接入正式coordinator；还必须处理失败catch再次封存/发布、旧数组依赖、取消与启动恢复。当前生产协调器尚未切换，完整15/42未完成。


## CX：默认协调器接入与失败策略

默认auditStorage=entries；显式json仅保留兼容/注入测试路径。beginRun+writer.start同连接事务，scanner传auditSink，cleanup直接写writer且不保留完整审计数组。终结仅构造summary/metadata，以一次finishedAt在同一事务refreshPendingGroups、seal、finishEntries；未识别路径使用新的同步生成器，保留原目录首匹配/授权/归一化。

文件/NFO/cleanup持久化错误不等于存储持续不可用：所属事务回滚后尝试一次failed发布，保留之前已提交事实。失败发布再失败则尽力标记未发布run失败；正常终结阶段失败直接走该降级，不重复refresh/seal/publish。降级不改已发布run，更新失败时保留running供启动恢复；原始错误始终优先，staging保持隐藏，后续恢复abandon而不删除条目。

ScanFoldersFailure在sink模式将停止修改后的ScanResult转交coordinator，保留cause及已提交计数，不复制大数组；pendingGroups错误出口按Set补齐，storage错误不额外加failed。coordinator验证library/run后使用partial结果。无法用于强杀进程后的内存计数恢复。

接入后发现audit-only写入改变total_changes，导致STRM索引重复全量加载。真实20文件回归从10次重建降为1次；已知审计写入只更新修订，嵌套无资源写交外层资源变更更新，真实资源嵌套/外部修订/失败仍失效。该证据是特定路径的查询次数，不是全负载吞吐或RSS结论。

246联合通过；全量2673通过/1跳过/0失败，build退出0。新旧完整结果/audit差分与真实NFO、pending、cleanup、header、未识别替换及开始/文件/清理/派生/封存/发布/取消/降级恢复已测。证据见large-library-results/implementation/batch-cx-manifest.json。

下一步优先审计并移除剩余ScanResult与扫描发现/预检/NFO集合、membership清理全集；对正式新格式测写入/终结/读取的吞吐、主进程阻塞、RSS和磁盘成本。Windows/HDD、并发、长期及真实进程中断矩阵、初始primary中断恢复仍未完成。完整15/42继续。


## CY：无资源成员关系清理逐项交付

默认 entries 协调器改用 `removeResourceLessMembershipsWithAudit`，只接收删除计数并在回调中写 deletedVideos，不再保存这类删除结果全集。旧数组接口包装同一实现，显式 JSON 扫描仍保留旧结果合同。

事务中用 TEMP 表固定最初符合条件的影片 ID、番号和标题，按 ID 每页最多256条读取；读取完成后再删除及执行同步回调，允许内置 writer 使用嵌套保存点。删除时仍复查 pinned、清单引用和当前库资源，仅实际删除成功才记审计和计数。回调修改后续候选名称不改变快照，新增候选不进入当前清理，后来受保护或被 IGNORE 的项跳过。成功 DROP TEMP，异常与全部清理/审计共同回滚；拒绝并观察 thenable。保留全局影片及其他库成员关系。

合成探针 `scripts/performance/membership-cleanup-benchmark.ts` 使用内存库、1KiB标题、ANALYZE，每规模预热1次后测3次，回调仅校验 ID/计数。1万项22.67–23.32ms；10万项304.33–356.93ms，首次回调81.24–127.46ms。计时排除 durable commit、真实审计编码/写入和FS，不能视为端到端、冷盘或p95。即便此简化负载也超出250ms同步段候选上限，证明 PERF08 主线程阻塞仍未完成；后续必须隔离或重新设计可恢复分批清理，不能直接在当前事务内 await。

这次只限制 JavaScript 候选页行数；完整名称未截断，单项字节、SQLite TEMP总量和事务写锁时长仍随数据增长。测试/构建最终结果见实施记录CY；完整15/42目标保留。

后续 ScanResult 数据流核对：`newCodes` 目前由两处导入路径累加，生产消费未发现依赖；`unrecognizedFiles` 同时用于扫描通知、coordinator安全清理判断、单文件改名导入结果及旧JSON发布。不能直接清空数组：需要明确计数合同并一并更新失败分类、取消/partial结果和IPC，正式未识别路径已有封存entries读取器。此段是后续设计证据，尚未实施。


## CZ：扫描完成结果与明细分离

正式 entries 扫描显式使用 summary 模式：初始化只有 `unrecognizedCount`，不创建或填充 `newCodes`、`unrecognizedFiles`。直接 scanner 默认 detailed；单文件改名重试显式要求 detailed；旧JSON审计仍使用完整路径数组。summary 模式要求逐项审计接收器，不能仅为了少传数据而丢弃文件详情。

`ScanCompletionResult` 是完成返回与事件合同，`ScanExecutionResult` 仅用于共用内部逻辑。coordinator所有正常/早退/取消返回及completed事件经字段白名单投影，IPC、自动扫描依赖、前端controller与通知统一消费计数。运行时投影也会排除结构类型对象中额外携带的旧数组；不能只靠TypeScript的Omit隐藏属性。

两处本地/STRM无法识别分支改为先recordFile成功，再增加failed与无法识别计数/路径，修正致命审计失败时未持久条目被计入partial的问题。scannedFiles仍表示尝试数；无法识别计数不从最终去重的审计行数反推。sink错误的partial保留对应模式、已提交计数与原cause。coordinator用真实计数区分普通处理失败，普通处理失败依然跳过危险清理。未识别文件替换仍从sealed entries映射，并与发布同事务，不从IPC结果重建。

真实scanner对照中1个未识别文件完成JSON为297B，300个为303B，三个计数字段各增加2位；重复请求路径执行计数为2而最终审计为1。该夹具只验证结果表示，不是RSS或吞吐测量。

此改动消除默认生产结果中的两个全集，不代表整个扫描或IPC字节全面有界：离线目录、STRM诊断、目录发现/预检/NFO规划集合仍保留。CY确认的同步清理阻塞以及平台/长期/故障矩阵继续；最终验收和证据见实施记录CZ。


## DA：目录身份摘要，避免 NFO 重复遍历整个目录番号列表

原scanner为每个目录保留全部视频/STRM的文件名番号数组；sidecar定位和通用资产归属每次调用sameLogicalCode都会重新归一化整份数组。同目录N个anchor反复判断，最坏出现O(N²)工作。现在扫描器每目录构建不可变摘要，记录数量、首个规范番号和一致性，每个anchor共享完成后的摘要，后续判断只读取固定字段。普通扫描仍按files累计，定向扫描仍按原isFile规则统计全部兄弟文件，不把目标路径重复次数当作兄弟数量。

旧数组输入仍可用，手工适配器保留原目录过滤/排序实现；数组predicate改为不创建归一化数组的直接判断。零项false、单项无条件true（包括null/空白）、多项必须全部有效且规范化后相同，均与独立旧实现oracle对照。不额外引入番号格式校验；summary是常量字段数量，所保留的一个番号字符串仍不承诺固定字节上限。

NFO关闭时不构建sidecar和目录身份索引，定向扫描也不再为此枚举兄弟目录。主文件处理循环结束后释放files、目录索引、NFO预检和新番号计数的外层容器；排队NFO anchors仍持有必须的摘要和sidecar上下文，当前批次事务与取消后的审计收尾规则不变。

诊断red使用真实scanner观察到旧数组；真实adapter差分覆盖movie.nfo、同名NFO、poster/fanart的归属：同码分卷/单未知目录可采用通用内容，混合身份/未知兄弟保持歧义限制。生命周期释放只减少NFO应用阶段的无用引用；发现、预检和排队anchor此前峰值、sidecar数量、单目录readdir及手工路径重复读取仍未解决，不能称整个NFO流程已线性化。独立对照探针每规模预热1次后取3样本：1,000项旧16.16–16.59ms、新0.071–0.091ms；5,000项旧403.73–406.75ms、新0.230–0.268ms。新路径计时包含一次摘要构建和每anchor一次判断；不包含文件名解析、FS、NFO解析/应用或审计，不据此宣称整个扫描加速倍数。最终测试与证据见实施记录DA。


## DB：NFO采集中的目录读取复用与缓存准入预算

默认适配器过去为同目录每个资源读取兄弟番号列表，再在sidecar定位时读取目录。现在production anchor枚举用同一次成功readdir构建身份摘要及sidecar索引，按library/root/词法目录隔离复用；直接collectFromAnchors对未提供sidecar map的anchor也在本次调用中复用成功索引。下一次调用重新读取，缓存不保存内容、capability或授权结果；文件issue/read和根目录状态检查仍逐项执行。

成功空目录也属于快照；失败不缓存，下一anchor重试。生产枚举失败的anchor保留原单项番号fallback及未提供的sidecar map，允许collect阶段继续重试。直接collect读取失败只给当前locator空map，避免立即重复读取。显式提供的map（包括空map）和目录身份保持权威，而且不会被拿来填充其他anchor的共享缓存。

复核发现无上限保留新sidecar maps会增加多目录峰值，故最终方案增加非驱逐准入预算：production枚举缓存与collect读取缓存各最多64 scopes、1MiB编码字符串，两层合计最多128 scopes、2MiB这类缓存数据。计费包括scope key、规范番号、map实际键和值的JSON字符串UTF8字节，不是完整对象序列化或JS堆字节上限。不计调用方原已提供的map、未准入anchor的摘要、临时readdir/map构建和对象开销。

超限不是丢数据：production不缓存该快照，也不把被拒绝的sidecar map附着到anchors；保留身份摘要，后续按需读取。直接collect完整使用当前未准入map后释放，不驱逐已准入快照、不保存拒绝key全集。测试覆盖65 scopes、精确字节边界、拒绝不占预算、超大目录和输出等值；大目录超限会回到重复读取成本，不能保证所有分布均为一次listing。

实际默认适配器合成对照（同影片同目录分卷，共享movie.nfo，仅采集title）每规模预热1次后3样本：100资源从200次listing/32.66–34.94ms到1次/9.55–10.10ms；1,000资源从2,000次/2,410.44–2,433.81ms到1次/84.13–85.58ms。包含数据库/root/file授权及collect，排除夹具准备、候选应用、完整扫描、冷盘/p95/Windows/HDD/RSS。最终有界版本复测，不沿用无上限中间版本的计时。

资源/anchors全集、图片搜索的其他目录枚举、超限目录的临时峰值、扫描预检/NFO队列及CY同步清理仍未完成；此处只解决有预算的目录复用。最终测试及证据见实施记录DB。


## DC：默认扫描文件清单改为有界缓冲的 TEMP spool

正式 summary 扫描不再收集每个根目录的 rootFiles 数组和总 files 数组。发现时将路径及 root ID 按发现 ordinal 写入独立 TEMP 表，每批最多256行和1MiB UTF8路径字节；达到行/字节预算后提交短事务，再由 scanner 让出事件循环。单条路径超过1MiB明确失败，不截断或丢弃。显式 detailed 模式保留内存清单作为兼容路径及差分基准。

发现结束后 seal，后续多轮预检、计数及文件处理都使用重新创建的 ordinal keyset reader。先读取最多256条 ordinal/path_bytes 窄元数据，在投影完整路径前计算最多1MiB的 ordinal 范围，再用 SQL 范围及 LIMIT 读取路径；没有活跃 SQLite cursor 跨越 yield、await 或业务写入。重复路径、跨根顺序均保留，不使用路径唯一约束，不在消费时删除行，因此不会因逐页 TEMP 写入反复失效 STRM 索引。

创建和 append/seal/dispose 均拒绝已存在的调用方事务。否则保存点成功后更新内存 ordinal、清空缓冲，但外层事务回滚可导致静默丢项；DROP 被外层回滚也可能留下无法再清理的表。所有拒绝发生在状态修改前，读取期间仍允许调用方执行独立业务事务。原生 INSERT 故障整批回滚，失败 append 不被接受、先前缓冲保留，重试不会重复序号。

取消发现或预检、正常结束和异常出口均清理 TEMP；正常路径在 NFO 尾部前释放。DROP 失败允许重试，清理错误不会掩盖原始扫描错误。symlink 分支只捕获 stat 错误，追加/flush 故障向上传播，防止将存储故障误当不可访问文件跳过。持续 DROP 失败可能保留 TEMP 到连接关闭，不宣称故障路径必定立即回收。

独立清单探针采用固定192字节路径，1次预热+3样本、每规模先内存后spool、三次完整遍历并核对数量及checksum。10万路径：内存39.19–42.97ms、spool230.99–236.28ms；60万路径：内存216.29–222.93ms、spool1372.57–1382.52ms。60万spool发现阶段697.46–705.64ms，分2343次满批flush，另有seal尾批；观察到单次append最大约9.67ms。新增读写成本是有界路径清单留存的取舍，不声称吞吐提升。

探针为内存数据库上的实际TEMP表，包含路径构造及每次append计时开销，未强制GC；不包含完整FS发现、NFO/业务写入/审计、事件循环让步及释放成本，不代表RSS、整扫描同步段上限或Windows/HDD/p95结论。页与缓冲预算仅计算路径UTF8字节，不包括root对象、窄元数据或JS对象开销；SQLite TEMP总量仍为O(文件数)。目录readdir/sidecars、NFO预检及排队anchors、newFileCounts和primary IDs全集、同步清理及平台矩阵仍需后续处理。


### DC 后拟定的实施顺序（历史方案；最终实现与修正见DD/DE）

下一批先替换 summary 的 newFileCounts：TEMP以精确code为键保留真实计数，发现顺序、重复路径、跨root合计、已有资源/pending排除和无效STRM逐次扣减都不变；不能将计数饱和到2。分批add/finishCounting、修正阶段get/decrement、freeze后只读，再与inventory独立清理。当前主文件try/catch会将计数SELECT故障降级为processing_failure，必须明确将新增存储故障上抛。所有计数写入须在STRM索引首次加载前结束，不需要放宽全局修订规则。验收包括多无效STRM扣减、NFO改号/冲突、重复根、原生INSERT/UPDATE/SELECT/DROP故障、取消与多个disposer均尝试。

之后统一设计NFO工作集，而不是仅驱逐目录Map：当前preflight与queue anchors共同引用目录快照，目录重新读取可能改变归属判断。TEMP应保留词法目录快照的完整有序sidecar键值、exact-path非missing preflight最后写入语义、原冻结root引用、video首次入队顺序和每video anchor追加顺序。按视频恢复并应用，保持同影片候选合并及业务/audit事务；现有apply仍接收完整单影片anchors，故这一阶段也不能宣称整体固定内存。主循环队列写入要纳入已知不修改资源的revision包装；原生存储错误不得变成missing/warning。此设计尚未实施，具体接口和单项字节预算需在下一批结合测试确认。


## DD：预检计数的有界存储与不必要阶段消除

summary关闭自动合并时，用TEMP计数替代不同番号的完整JS Map。缓冲最多256次出现及1MiB编码键，使用JSON字符串编码和BINARY比较保留NUL、孤立代理项、大小写等精确键身份；计数不饱和到2，无效STRM逐次扣减至最小0。构建、调整结束后freeze，业务循环只有读取，不因计数写入反复失效STRM索引。summary开启自动合并时，两处确认判断均不使用计数，因此完全跳过计数器和遍历，但保留首次业务写入前事务外让步及取消检查。

创建/变更/释放在状态修改前拒绝调用方事务，失败追加不被接受、缓冲事务回滚后可重试。专用错误保留cause，在主文件catch中直接上抛，不降为processing_failure。计数与文件清单独立尝试释放，首个清理错误不阻止后续释放，原始失败不被掩盖。

初版每次get/decrement重新prepare的成本由独占探针证实，最终改为每store复用语句与事务函数，准备失败和DDL一起回滚。10万不同code、每code3次add/1次扣减/3次get：初版TEMP3178.87–3508.77ms，最终1279.51–1367.67ms；最终memory后端87.78–100.07ms。各1次预热+3样本、内存数据库，包含code构造，排除工厂/释放、FS/NFO/业务及事件循环让步；memory是带同类校验的兼容后端，不是未经改动的裸Map基线。新增TEMP仍比内存慢，收益是移除全量JS计数留存及自动合并模式的无用遍历；不是吞吐或整体RSS验收。

## DE：NFO目录、预检和待应用队列的扫描级工作集

NFO关闭时不创建工作集。启用时，summary采用本次扫描连接的TEMP目录、sidecar、preflight、作品队列和anchor队列表；detailed保留内存后端。目录副文件保持原键值及插入顺序，采用SQL索引get/has；ReadonlyMap遍历逐行get后yield，不跨await保留SQLite游标，不为每个anchor展开整目录。仅缓存最近一份目录身份和sidecar包装对象，未建立全扫描JS缓存。

目录在预检前封存，preflight在计数/导入前封存，apply队列在主文件处理后封存。保留精确filePath的非missing最后覆盖规则、原冻结root、目录身份和副文件快照，计数阶段只取effectiveCode。预检payload按显式anchor/root/snapshot引用编码，副文件不在每条preflight中重复复制；原warnings保留到既有审计投影时处理，不提前静默截断。编码字段及preflight、目录身份、sidecar键值等有效载荷组合按1MiB预算校验，超限明确失败；序号、snapshot ID、对象与编码临时开销不属于该预算。

作品按首次入队顺序读取，保留第一次code和每个重复anchor的追加顺序。一次恢复一个作品的anchors并调用原有一次apply；beforeCommit仍在业务事务内同步修订全部anchor审计，提交后的资产警告继续最终修订。取消先于读取下一作品检查，不先hydrate一个可能很大的下一批再取消；当前已提交批次的审计收尾仍完成。

**原子性修正：** 原拟定的提交后TEMP enqueue会新增存储失败窗口：资源已存在后，重扫可能跳过预检而遗漏NFO。因此四条summary成功新增/附加local/STRM资源路径均在资源及基础file audit的同一事务中enqueue，失败一同回滚，结果计数及primary集合仍只在提交后更新。enqueue是唯一允许加入调用方事务的变更：作品/anchor序号全部由SQLite管理，外层回滚没有JS游标脱节；其他工作集变更仍拒绝外层事务。资源无关修订包装保留，STRM资源外层修改负责其最终索引更新。detailed保留提交后内存入队行为。

工作集错误在目录包装中保留cause，并穿透inspectIdentity、逐文件和NFO apply的普通warning catch。所有出口尝试释放全部临时资源；工厂错误回滚DDL，DROP失败可重试，原始错误不被清理错误覆盖。detailed的真实Map快照在dispose后仍可由原有调用者读取；summary SQL快照仅在本次扫描/apply生命周期内有效。

### 最终边界与停止决定

本轮到此收尾，不继续其他性能工作包。完整同作品候选判定和事务是保留的业务合同；单作品anchors/候选仍可能很大。当前目录readdir/indexNfoSidecars输入仍是完整瞬时对象，单目录写入仍是同步事务，尚无整个NFO阶段250ms或总内存保证。SQL TEMP总量随数据增长；预算不包含所有对象、编码临时字符串及SQLite缓存。详细模式仍保留全量内存语义，不能把它用作有界模式。

TEMP不是崩溃恢复账本，进程退出后不恢复该NFO队列；本轮原子性保证针对当前资源事务中的入队失败，不替代长期恢复/平台故障矩阵。手工采集的单作品资源/anchors与候选聚合接口未拆分；DB目录复用收益仍有效，但单作品极端规模另需设计。CY同步清理、启动迁移/全库校验/退出交割以及全套15工作包/42风险均保留在[完整计划](large-library-optimization-plan.md)；这些不是自动继续执行项。最终联合测试、构建与证据hash统一见实施记录收尾批次。
