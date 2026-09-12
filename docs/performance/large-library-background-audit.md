# 大型媒体库后台处理性能审计

审计日期：2026-09-10。代码基线：`dev`，`4c953a960d910aed3fb102b39a337b418c6292f9`。本报告仅分析后台处理，不修改生产代码，不访问用户数据库，不向 GitHub 发布内容。源码定位使用该提交的仓库相对路径与一基行号，后续代码变化可能使行号失效。

## 结论与证据边界

应先处理全量扫描的超大数组展开、主进程同步读图、批量任务整份 checkpoint 重写、加密别名表逐项整表重写，以及扫描收尾和 NFO 规划中的不可中断工作。它们是可从调用链证明的规模风险；本次没有测得其在 Windows HDD 上的耗时、RSS 或吞吐，也没有证明它们就是 Issue #100 中搜索延迟的根因。

背景来自已只读获取的 [Issue #100：界面搜索之类的操作很慢](https://github.com/JavdexLabs/Javdex/issues/100) 正文、标签和评论：报告者使用 Javdex 0.6.2 / Windows x64，300,382 部影片、约 1 GB 数据库，封面目录位于机械盘，并称约 24% 封面缺失。上述规模、缺失比例和工单内计时均属**报告者陈述，未在本次复测**，也不能直接代表当前 dev。1 GB 指数据库，不是内存预算；影片数不等于源文件数或图片数。

本次读取根 `AGENTS.md`、`docs/agents/issue-tracker.md`、开发指南、媒体资产与批量 lifecycle ADR、多媒体库设计、NFO 兼容性相关内容，并核对扫描、NFO、队列、资源、协议和启动源码。目录查询的 SQL 执行计划、UI 渲染和 Web 服务端由其他审计负责；这里仅记录后台调用方发起全量查询、N+1 或事务的方式，不重复评估列表 SQL。

记号：F=本次发现的源文件数；R=库内源管理资源数；S=STRM 资源数；P=待确认资源数；T=批量刮削目标数；A=图片资产数；E=导出文件项数；B=相关文件总字节数。复杂度为代码结构推导，省略单条数据库查询、单次磁盘访问与编码的实际成本。优先级 P1 表示大型库优化首批，P2 表示专项任务或后续工作；本次没有经复现确认的 P0 数据事故。

| 编号 | 优先级 | 触发 | 已证规模风险 |
|---|---|---|---|
| BG-01 | P1 | 大根目录扫描 | 全量路径/审计驻留；`push(...全量数组)` 触及引擎参数上限风险 |
| BG-02 | P1 | 无变化重扫、待确认重扫 | 多轮逐项查询和同步 stat；部分预处理不让步；待确认时长重复探测 |
| BG-03 | P1 | 新增/移动大量 STRM、待确认项多 | 重定位 O(新增 STRM × S)，审计匹配最坏 O(P×F) |
| BG-04 | P1 | 扫描结束、读取审计 | 事务内逐文件查盘；全量 JSON 序列化和 IPC |
| BG-05 | P1 | 新发现文件自动导入 NFO | 同步重复解析；尾部应用不检查取消 |
| BG-06 | P1 | 大批量影片/演员刮削 | 每项重写 T 个目标，累计 O(T²) 清单处理/写入 |
| BG-07 | P1 | 封面首次/重复读取 | `media://` 同步文件读取与解密，已有字节 LRU 未接入 |
| BG-08 | P1 | 加密资产逐步增长、批量加解密 | 每图重读/重写完整别名表，累计 O(A²) |
| BG-09 | P1 | 全库 NFO 导出 | 规划全量快照、N+1、内存计划与预览，无规划取消 |
| BG-10 | P2 | 资产根目录搬迁 | 同步枚举/复制/全量二次校验/删除，收尾不让步 |
| BG-11 | P1/P2 | 扫描、快速批处理 | 扫描每文件两条 IPC；其他进度未按时间合并 |
| BG-12 | P2 | 大量恢复项或暂存垃圾启动、运行中退出 | 窗口前同步恢复清理；缺少统一扫描/刮削 drain |
| BG-13 | P2 | 图片导入/解码、插件多 URL 持久缓存 | 同步解码与重复读取；缓存配额检查逐次枚举目录 |
| BG-14 | P1 | 长轮次插件/元数据 Agent | 完整 workLog 重写、journal 全读取游标、历史恢复全解密 |
| BG-15 | P2 | 累积 Agent 历史与插件任务归档 | 关闭不删 DB 历史；恢复入口重复加载全部非 closed run |
| BG-16 | P2 | 大附件元数据候选、多次采集 | 单候选集中持有最多 200 MiB 图片再同步暂存、读回 hash |

## 已追踪的入口和现有控制

1. 手动扫描：`apps/desktop/src/main/ipc/scanHandlers.ts:62` → `scanCoordinator.run` → `apps/desktop/src/main/scanner/scanCoordinator.ts:280` → `scanFolders` → 查验安全根 → 清理事务 → 持久化运行。扫描有单运行控制、AbortController、冻结配置与根目录快照。自动扫描走同一 coordinator。
2. 自动扫描：`apps/desktop/src/main/appMain.ts:223` → `automaticScanScheduler.start`。`apps/desktop/src/main/services/automaticScanScheduler.ts:7` 定义启动延迟 30 秒、唤醒延迟 3 秒、轮询 60 秒；`:106` 检查运行状态/维护锁，到期库按顺序扫描，`:122` 以结束时间或启用时间判断到期。**当前 `apps/desktop/src/main` 未发现 fs.watch/watchFile/chokidar 媒体目录 watcher，不能把它描述成逐文件变更触发的 watcher 风暴。**风险来自定期全扫。
3. 批量刮削：`apps/desktop/src/main/ipc/scrapeHandlers.ts:18` 接线 controller；`apps/desktop/src/main/services/scrapeJobController.ts:305` → 独占 scrape coordinator → `CheckpointedSequentialBatchQueue` → `SequentialBatchQueue` → 单目标 scraper/apply。影片策略 `apps/desktop/src/main/services/videoBatchScrapeQueue.ts:180` 每 50 次尝试回收浏览器窗口；`:79` 恢复作用域校验已按 500 ID 分块，`:182` 每项再次校验成员关系。不能建议无约束并行共享浏览器。
4. 本地 NFO：扫描 preflight → `localNfoScanService` → `LocalNfoSourceAdapter` → 带物理身份检查的 `NfoFileStore` → candidate staging / `videoScrapeApplyService`。只对首次发现的资源自动导入；不是每次重扫都重写 NFO 元数据。
5. NFO 导出：`NfoExportTaskController.plan/start` → `NfoExportModule.plan/apply`。它虽在主进程执行，但现有产品合同是前台阻挡的一次性导出，不是可长期恢复的后台队列；性能改进不应擅自更改该合同。
6. 图像：`apps/desktop/src/main/appMain.ts:135` 协议处理 → `apps/desktop/src/main/services/mediaAssetStore.ts:190` → `mediaAssetStore/filesystem.ts:69` → 明文读取或 `assetCrypto.decryptBlob`。图片读取和原视频时长解析是不同路径，不能混称为“扫描读取全部影片字节”。

## BG-01：全量扫描清单与超大参数展开

**证据。** `apps/desktop/src/main/scanner/scanner.ts:201` 递归收集路径，`:469` 创建全量 files 和目录索引，`:481` 每根额外创建 rootFiles，`:504` 执行 `files.push(...rootFiles.map(...))`。`:513` 再构建目录番号集合；`:520`、`:584`、`:626`、`:627` 保留 NFO preflight、番号计数、逐文件审计和 NFO 批次；`:1351` 才统一输出审计。`:1126` 等路径保存所有无法识别文件。复杂度至少 O(F) 内存，且同时包含多组对象/字符串引用，并非只有一个路径数组。

大数组作为函数实参展开具有运行时参数个数上限；单根涵盖 300,382 个文件时应列为首批复现项。这里**未在目标 Electron/Windows 执行，未声称其具体上限或已经崩溃**。同类风险还见 `apps/desktop/src/main/scanner/scanCoordinator.ts:413` 至 `:421` 的清理结果展开：此处位于清理事务之后，若展开失败，会出现清理已提交而收尾失败的诊断问题。

**已有缓解。** `readdir` 为异步、使用 Dirent，递归检查 signal，符号链接 stat 为异步且坏链接跳过（scanner `:207` 至 `:227`）。STRM 错误只保留 50 条（`:640`），NFO 审计警告限制为 20 条、每条 500 字符（`:168`）。这些限制不约束 files 或普通审计总量。

**建议。** 首先用逐项追加或小批拼接消除可变大实参。随后使用异步目录迭代及有界发现缓冲；番号重复判定需要全局信息时，以扫描临时索引/磁盘清单承接两阶段发现与应用，而非强行单遍立即写库。逐项审计持久化，内存保留计数和当前页。

**正确性。** 同番号跨目录资源仍须在首次自动合并前识别歧义；movie.nfo 的目录所有权、冻结根目录、定向重识别不得扩大扫描范围。异步流未成功枚举完或取消时不得清理“未看见”的资源。

**验收。** 合成 300,382 和 600,764 路径的单根/多根运行均无 RangeError；不得依赖高栈参数。发现缓冲上限明确（起始建议 500 项），关闭 NFO 与开启 NFO 均验证；目录未枚举完即可报告发现数量。记录每阶段峰值 heap/RSS，验证额外内存不再随全量逐文件审计线性驻留。

## BG-02：重扫预处理、指纹与时长探测

**证据。** scanner `:528` 至 `:534` 对已有资源跳过 NFO，但该 continue 绕过 `:577` 的让步；开启自动 NFO 的无变化库，预检可以连续做 F 次同步存在性查询。`:585` 至 `:597` 的新文件计数循环同样逐项进行最多四种存在性查询，无取消检查、无 setImmediate。`:976` 至 `:985` 已注册本地资源分支重复取 locator，进入 `:371` 的 refresh 后再次查指纹/目标。`statFileFingerprint` 在 `:285` 使用 `statSync`。普通处理默认每 50 项让步（`:152`、`:194`），不能覆盖预处理中的连续同步工作。

待确认本地资源分支 `:1036` 至 `:1052` 直接 `await readDurationSeconds(file)` 后写回指纹，没有与待确认行已有指纹比较；大量长期未处理待确认文件每次重扫都会再次探测。`apps/desktop/src/main/scanner/videoDuration.ts:145` 的已注册资源判断已能跳过“有效时长且指纹不变”的探测；`:149` 对未知时长始终重试。`:66` 的 parser 无外部 AbortSignal/时限参数。

**已有缓解。** 时长解析使用 tokenizer、skipCovers，观察到 duration 即关闭句柄，finally 再确保关闭（videoDuration `:71` 至 `:111`）；并非必然读取完整视频。`scanner.ts:296` 可复用本次最小时长过滤已探测值。成功记录的时长与 size/mtime 是重要优化，须保留。

**建议。** 以批量存在性查询和窄字段结果支持预处理，复用同项已取记录；所有循环按时间预算让步，而不是只数成功/NFO 新文件。待确认项也复用 size/mtime/探测状态；未知时长持久化“本指纹已探测未得结果”与可重试策略。将 stat/容器探测放入可取消、有时限、有界并发的 I/O 执行器，HDD 初始并发建议 1–2，实测再调。

**正确性。** 指纹改变必须重新探测；未知时长不等于低于最小时长，不得改变现有 null 允许导入语义（videoDuration `:121`）。不能缓存失效根的授权结果无限期使用；根物理身份及符号链接边界须维持。

**验收。** 无变化、有效时长的 300,382 文件容器探测次数为 0；待确认同指纹第二次扫描探测次数为 0（除显式重试策略）；所有预处理阶段取消均能被观察。使用延迟 I/O 注入验证时间预算让步有效，而非以 Promise 包装同步函数充当异步优化。

## BG-03：STRM 重定位与待确认审计的乘积复杂度

**证据。** 新 STRM 走 scanner `:819` 的重定位候选查找；`:269` 每次获取库内全部 STRM 引用，再按 basename 过滤、逐候选取资源及 stat 旧路径。U 个新路径与 S 个库内 STRM 会产生 O(U×S) 引用遍历，首次导入时 S 增长也可能形成平方累计工作。现存路径分支不走此查找，不应将平方成本套到所有无变化重扫。普通视频重定位 `:324` 按同番号候选取资源，成本依同番号集合大小，不是直接全库平方扫描。

`apps/desktop/src/main/scanner/scanCoordinator.ts:504` 至 `:527` 的 `refreshPendingAudit` 先取全部待确认组，再对每个资源调用 `auditState.files.some`，最坏 O(P×F)。这是 JS 匹配成本，即使底层查询变快仍然存在。

**已有缓解。** STRM 必须唯一候选才重定位，旧路径须 missing，离线根被排除（scanner `:269` 至 `:278`）；审计用 Set 先过滤本次 group ID，降低部分场景的 P。

**建议。** 单次扫描建立按 basename/目标键的窄候选索引，或专门的按键查询；随本次插入/移动更新索引。审计预构建 pending filePath Set 或按 group 的计数映射，达到 O(F+P)。

**正确性。** 保持唯一候选、missing/unknown 区别、根归属和 pending 身份歧义；path 匹配保持当前语义，不能借优化私自变更跨平台大小写规则。

**验收。** 全 STRM 新导入及整目录移动的规模翻倍时，候选检索/JS 比较次数增长接近 2 倍，非 4 倍；全部待确认的扫描审计比较次数 O(F+P)，输出与小规模原实现逐项相同。

## BG-04：扫描尾部同步清理、持久化与审计传输

**证据。** coordinator `:360` 至 `:409` 在一个清理事务内 reconcile pending、逐资源确认缺失并清理成员；`:688` 至 `:723` 全量读取引用、每资源 getResourceById、同步 inspectPath，缺失时再取该影片全部资源选主资源。默认依赖在 `:759` 至 `:781` 明确连接生产 repo 与 inspectLocalPath。此阶段 O(R) 查盘和多次逐项 DB 调用，循环内没有 await/取消检查，不能靠前面扫描每 50 项让步消除卡顿。

`packages/library/src/db/libraryScanRepo.ts:174` 至 `:188` 在事务里 JSON.stringify 完整 audit 后写入。`packages/library/src/scan/libraryScanAuditStore.ts` 读最新 DB audit 并完整 JSON.parse；JSON 文件写入只是另一个 API，**不是当前 coordinator 默认完成路径**。`apps/desktop/src/main/ipc/scanHandlers.ts` 原样返回完整审计，reveal 单文件也加载完整审计。成本 O(审计字节数)，不是一页结果。历史保留策略应由数据库主审进一步核查，本报告不由这一调用单独断言磁盘无限增长。

**已有缓解。** coordinator `:308` 重新检查根；取消和处理失败跳过清理（`:315`、`:338`）；unknown 路径使清理事务失败，避免将断盘当作缺失（`:696`）；仅完整安全扫描执行无资源成员移除（`:405`）。单项导入已有 repo 事务，例如 `packages/library/src/db/videoRepo.ts:314`，不能建议给整个异步扫描套一个超长事务。

**建议。** 将可耗时文件检查移出写事务，形成有界批次的候选删除计划；提交前复验根身份/必要文件证据。清理分批方案必须先定义跨批恢复/运行状态，不能简单拆事务丢掉全阶段回滚保障。审计拆成 summary + 分页 detail，序列化移出锁窗口；reveal 使用限定 run/library 的路径成员查询。

**正确性。** 取消、不完整枚举、权限错误、离线/换盘均不得删除历史资源；主资源选择与库间隔离不变。若维持原子清理，则可先只移出查盘并保持最终事务，实测后再决定分批。

**验收。** 记录最长清理事务时长、其中 FS 调用数和主进程事件循环延迟；目标事务内不做批量查盘。审计首屏 IPC ≤500 条且 ≤1 MiB，路径 reveal 不反序列化整库审计；完整导出/审计计数与持久记录一致。

## BG-05：NFO 自动导入的重复读取与取消空档

**证据。** scanner `:545` preflight 的 `inspectIdentity` → `apps/desktop/src/main/metadata-sources/localNfoSourceAdapter.ts:314` 读并解析 NFO；导入 `:362` 再读并解析。同名 NFO 与 movie.nfo 并存时，`apps/desktop/src/main/nfo/nfoSidecarLocator.ts:101` 还读取两文件比较。不是单纯一次 XML 解析。scanner `:1293` 至 `:1322` 对已经累积的 NFO 批次逐个 apply，没有 signal 检查或显式事件循环让步；随后选主资源和审计输出（`:1326`、`:1351`）也没有。主扫描循环取消后仍可能处理已积累 NFO 批次，coordinator 到返回后才再次识别 signal。

**已有缓解。** NFO sidecar 在目录枚举时索引，避免每影片为寻找 NFO 重读目录（scanner `:482`）。`collectFromAnchors` 以物理文件键去重（adapter `:345` 至 `:358`）。`apps/desktop/src/main/nfo/nfoFileStore.ts:59` 校验打开的文件身份及大小；codec `:5` 至 `:8` 限制 NFO 2 MiB、深度 64、节点 50,000、字段 256 KiB。`apps/desktop/src/main/services/localNfoScanService.ts:50` 至 `:61` 跳过已刮削/无需补齐的影片；本地图片读取上限 64 MiB（`:91`、`:139`），禁止远程下载；冲突候选保留，不自动覆盖已存在字段。

**建议。** 为单次扫描采用有界的物理身份+size/mtime 解析缓存，在应用前复验变化，复用未变的解析结果；对 NFO 应用、主资源选择、审计输出补齐时间片和取消边界，将能力票据与读取安全校验保留。不能因缓存命中跳过物理身份核对。

**正确性。** 同番号多资源 NFO 候选去重与冲突保留、fillEmpty、演员身份和来源记录不变。取消时区分已交割影片和未开始批次，不让文件先写库后失去审计。

**验收。** 每个未变化物理 NFO 的 XML 解析每轮最多一次（需要重校验不等于重新解析）；在 preflight、尾部 apply 及审计阶段注入取消，已完成项可追踪，取消后不启动新批次，且不执行缺失清理。损坏、2 MiB 上限、同名冲突及读前换文件回归保持。

## BG-06：批量刮削 checkpoint 的平方写放大

**证据。** `apps/desktop/src/main/services/checkpointedSequentialBatchQueue.ts:114` 全量 resolveTargets/create；`apps/desktop/src/main/services/batchScrapeControl.ts:89` 拷贝目标成 `{id,label}`，`:135` restore 又 map 全量目标。`sequentialBatchQueue.ts:140` 每完成一个目标调用 checkpoint → `checkpointedSequentialBatchQueue.ts:183` → `batchScrapeControl.ts:107` 保留整个 job → `batchScrapeJobStore.ts:99` 同步漂亮打印 JSON 并覆盖文件。每项 O(T) 清单序列化/写入，完成 T 项累计 O(T²)，即使每个 scraper 都很快也无法消除。

**已有缓解。** 串行执行、持久游标、进程内 job cache（job store `:105`）、最多 200 条日志（sequential queue `:6`、`:189`）；启动把 interrupted running 收敛为 paused（`scrapeJobController.ts:165`）。这些降低竞争、日志和重复读盘，不降低每项整清单重写成本。批量延迟由插件级 `apps/desktop/src/main/services/scraperDelayController.ts:31` 控制；不是每项无条件双重等待（checkpointed queue `:201` 关闭 generic delay）。

**建议。** 冻结 targets 清单写一次，进度用小型原子 checkpoint/追加 journal，或者独立任务表按页读取；保留每项 durable 进度而非只降低持久频率。当前写文件非 temp+rename 且错误只 log（job store `:98` 至 `:102`），优化时同时明确写失败的暂停/报错策略。暂停/终止仅在目标间检查（sequential queue `:105` 至 `:130`）；插件等待控制器不接 signal，长目标/等待不可立即中止。给等待及可取消下载传信号，提交中则在安全点结束。

**正确性。** 保持一个活跃/暂停 job、恢复作用域复验、当前项交割与 nextIndex 的顺序。现有“单项落库→checkpoint”也存在崩溃窗口；新方案需明确幂等重试或事务 outbox，不能承诺未经验证的 exactly-once。不得用提前更新游标避免重跑而漏掉未提交项。

**验收。** 无网络 stub 目标 T=1k/10k/100k 下，checkpoint 总字节数与 T 成线性，不再每项包含 targets；单项 checkpoint 固定预算（建议 ≤64 KiB，日志可分离）。记录写调用数、字节数、最长阻塞；断电/写失败/暂停/终止后恢复不漏已授权目标，范围变化拒绝继续，待确认计数正确。

## BG-07：media 协议未接入已有字节缓存

**证据。** `apps/desktop/src/main/appMain.ts:136` 的 handler 是同步函数，`:153` 读图；`apps/desktop/src/main/services/mediaAssetStore/filesystem.ts:71` existsSync、`:72` readFileSync，`:74` 同步解密。`apps/desktop/src/main/services/mediaAssetStore.ts:190` 直接委托，未包缓存。搜索生产代码确认 `getCachedAsset/setCachedAsset` 除定义没有调用。`apps/desktop/src/main/services/assetCache.ts:26` 的 256 项 / 96 MiB 字节 LRU **存在但没有服务协议请求**；不能在报告中把它当作已经生效的协议缓解。

每次请求 O(图片字节数) 读取，密文还产生明密文缓冲和 AES-GCM 工作（`assetCrypto.ts:59` 至 `:75`）；不是媒体协议对图片做 nativeImage 解码，解码发生在其他调用方。`appMain.ts:155` 没有显式 Cache-Control/ETag，也不意味着已证明 Chromium 所有层都不缓存。缺失图片当前每次走文件系统失败路径，无负缓存。

**建议。** 在 MediaAssetStore 保持统一边界，新增异步 readForServe、单路径 in-flight 去重、按总在途字节和数量限制读盘，接入有界字节 LRU；已有 inspection cache 用 mtime/ctime/size/resolvedPath 校验，可借鉴但不混淆两种缓存。协议增加条件请求或带版本 URL 的缓存合同。**不要原样采纳工单 `public,max-age=86400,immutable`**：同路径更新/删除和加解密切换没有一并得到版本化证明，持久明文缓存也需遵循加密/隐私语义。缺图短 TTL 负缓存须在写入时失效。

**已有缓解。** 协议和存储有路径边界检查，MIME 按格式输出；写删/迁移已有 invalidateAssetCache 接线；scrypt 密钥只在首次使用推导，随后缓存（`assetCrypto.ts:25`），不可按每张图片重复 scrypt 计算成本。

**验收。** 相同路径并发请求只做一次实际读取；热重复请求在未变化且有效缓存期内无正文读盘/解密；冷图请求不阻塞主进程同步读盘。缓存不超过既定 96 MiB/256 项，在途字节另计；替换、删除、根目录搬迁、加解密、404 后文件出现都不能返回旧内容。Windows HDD 的首批/重复 100 张请求分别记录延迟、主进程 event-loop 和 physical read bytes。

## BG-08：加密别名表的平方成本和恢复约束

**证据。** `apps/desktop/src/main/services/assetMigration.ts:16` 全量收集目标；每项 `:38` 重写文件再 `:41` remap DB，每 20 项让步（`:54`），无取消参数。枚举 `mediaAssetStore/cryptoMigration.ts:34` 同步 readdir+逐文件 stat，无让步。其 `:63` 调 `setPathAlias`，而 `apps/desktop/src/main/services/assetPathAliases.ts:44` 每次 readAliasMap→read/decrypt/JSON.parse 全表→writeAliasMap→JSON.stringify/encrypt/同步写临时文件和 rename（`:10`、`:31`）。解密 `getPathAlias` 读整表、`removePathAlias` 再读写整表（`:40`、`:50`）。新增 A 条别名累计 O(A²) 表条目处理。开启加密后的日常图片写入也调用 setPathAlias（filesystem `:114` 至 `:120`），不只设置切换受影响。

**已有缓解。** 图像逐项处理、固定间隔让步、单文件和别名文件临时写后 rename；`apps/desktop/src/main/ipc/settingsHandlers.ts:197` 使用 `runExclusiveRelocation`，成功后才更新 encryption 设置。仍没有批量 alias 快照或增量存储。

**建议。** 采用加密增量日志或分块别名存储、单次迁移索引，按安全检查点 compact；既支持有界读写，也避免把整个明文别名表新增到普通 SQLite 而破坏现有隐私语义。文件转换、DB remap、alias 交割应有可恢复日志。当前 `cryptoMigration.ts:68` / `:93` 删除旧文件发生在外层 DB remap 前，失败注入必须覆盖这一窗口；这里只确认时序风险，没有报告已发生用户数据丢失。

**验收。** A=1k/10k/100k 的 alias 解析/加密累计字节近似线性；单项 O(新增记录或固定块)，不扫描整别名表。中断并重启后，引用均能读取，不能缺 alias 或 DB 指向已删旧文件；撤销/继续策略明确。取消只在已完成单文件交割后生效，状态与实际资产格式一致。

## BG-09：NFO 导出规划和报告全量驻留

**证据。** `apps/desktop/src/main/nfo/export/nfoExportModule.ts:421` 在首个让步前取全量快照。repository `apps/desktop/src/main/nfo/export/nfoExportRepository.ts:96` 至 `:106` `.all()` 再 map hydrate；`:150` 至 `:184` 每资源分别取 tags/actors/ratings/identities/samples 及 root，至少五条逐资源附属查询，同影片多资源重复 hydrate。规划中 files/documents/plannedTargets/cover recipe cache 全量驻留（module `:412`），NFO Buffer 存在计划里（`:582`），`:687` 再创建完整 publicFiles，`:711` 返回完整预览。尾部 `:672` 全量重渲染 NFO 以处理之后发现的目标冲突，也没有让步。

controller `apps/desktop/src/main/nfo/export/nfoExportTaskController.ts:51` 持有维护和稳定资产读取租约，规划接口不接取消；`:141` terminate 只面向 running task；`:146` dispose 会等待 planning 全部完成。apply `:737` 文件间可终止，但 `:825` 仍为所有剩余项生成 cancelled 结果，最终完整 items 返回（`:843`）。内存 O(E+元数据+全部 NFO 字节)，规划/最终传输也为全量。

**已有缓解。** 每资源规划先 setImmediate（`:431`），每输出项 apply 后让步（`:822`）；已有目标 hash 使用 64 KiB 缓冲，不一次读完整目标（`:113`）。封面按 sourceHash 复用 recipe（`:502`），`nfoCoverArtwork.ts:66` 明确丢弃解码/编码缓冲，只留 recipe；不能声称全部解码图片在计划中长期驻留。规划 inspector 已按根授权缓存（`mediaLibraryRootFileGuard.ts:149`）；输出原子写，来源/目标变更会拒绝陈旧计划。

**建议。** 快照按资源 keyset 分页、按页批量 hydrate 并复用同影片元数据；持久临时计划+summary/分页预览，保留全局目标冲突索引而非简单独立分页输出。新增规划进度、AbortSignal、取消时释放租约。报告明细分页/落盘，取消只持久化范围与游标而不是立即创建 E 个 cancelled 对象。文件 hash/读写异步，重解码移到有界执行器。

**正确性。** 同物理目录/文件名跨页冲突、不同扩展名提示、root inode/device、来源 snapshotHash、覆盖策略、EXIF/海报方向与五个 profile XML 合同不能改变；不能为了快跳过 hash 而静默覆盖用户修改。

**验收。** 300,382 资源开启封面/样张/头像的最坏组合能完成规划，预览单次 ≤500 条/1 MiB；首次规划进度在全量 hydrate 完成前出现；取消规划后释放两个租约。按页查询次数与页数和附属表种类相关，而非至少 5R 次。计划驻留内存有明确上限，断开窗口不必等待全部剩余规划；所有 collision/stale-plan/终止合同测试保持。

## BG-10：资产目录迁移复制后仍有同步全盘收尾

**证据。** `apps/desktop/src/main/services/assetLocationMigration.ts:27` 递归同步枚举成数组；`:103` 对目标已有文件进行全内容比较；`:206` copyFileSync+rename。复制循环每 20 项让步（`:334` 至 `:355`），但 commit `:376` 调用 `:172` 重新遍历两边目录、逐文件做 64 KiB 同步全内容比较（`:71`），之后 `:380` 全量同步删除原文件，无让步；rollback `:405` 同步比较/清理。本任务至少 O(A+B)，多阶段重复 I/O 在同 HDD 上争用明显，但没有实测放大倍数。

**已有缓解。** 64 KiB 比较缓冲，临时目标文件后 rename，目标已有相同内容支持继续，拒绝符号链接/相同或嵌套物理根；先复制、设置交割、再清理源，并且 rollback 只删除确认未被替换的本轮副本。

**建议/正确性。** 枚举、复制、校验和清理均用可取消有界 I/O；进度增加阶段和字节数。保留源直到目标可验证且设置已提交；恢复日志追踪 file identity/hash，不能仅比较数量或存在性替换内容校验。后台删除源失败仍不回滚已完成的根切换。

**验收。** 从已有半份副本恢复、复制结束后源变化、目标被替换、不同盘/同 HDD 都记录分阶段字节与耗时；校验/commit/rollback 不产生整库同步事件循环停顿，取消不误删用户新增文件。吞吐目标待对应磁盘基线后设定，不承诺固定 MB/s。

## BG-11：进度事件与全量结果的 IPC 压力

**证据。** scanner 每文件 progress → coordinator `:286` 每次发事件 → `apps/desktop/src/main/ipc/scanHandlers.ts:50` 同时发 `SCAN_STATE_CHANGED` 和 `SCAN_PROGRESS`。若 F=300,382 且全部进入一次正常文件进度回调，代码推导为 **600,764 条进度相关消息**，不含开始/结束；不是采集到的运行计数。`apps/desktop/src/main/ipc/typedIpcAdapter.ts:51` 的发送器没有节流。刮削每项开始/完成、等待/log 都 emit（`sequentialBatchQueue.ts:127`、`:141`、`:195`），携带最多 200 条日志快照；有上限，不能称为无限日志增长。迁移每资产 emit（assetMigration `:29`），NFO 导出每文件 emit（module `:821`）。

**建议。** 在后台事件边界按 runId/taskId 合并最新进度，建议 100–200 ms 一次；保留开始、暂停、取消、错误和完成立即发送，完成前 flush 最终计数。可兼容两个扫描通道但让它们共享节流；后续迁移订阅方再移除冗余通道。任务明细采用游标增量，查询完整日志用独立 API。

**正确性。** 进度丢帧不等于丢审计；job/checkpoint 不以 IPC 是否送达为准；runId 隔离防止旧任务完成覆盖新任务。窗口不存在时保留后端状态供恢复读取，而非积压全部待发送事件。

**验收。** 连续进度每任务每通道 ≤10 次/秒，状态转换不受节流延迟；最终 counts 与持久状态完全一致。快速 stub 扫描/大量 skip 场景记录消息数、serialized bytes、发送时间，而非只检查 renderer 是否流畅。

## BG-12：启动恢复与退出生命周期

**证据。** `apps/desktop/src/main/appMain.ts:168` 打开库后进行 bootstrap/恢复；`:193` 至 `:203` 等待 Agent 恢复、执行待删文件恢复和孤立暂存清理，`:207` 才创建窗口。Agent 恢复进一步核查见 BG-14/15，其成本取决于任务历史，不声称与影片数成正比。`apps/desktop/src/main/services/pendingLocalFileDeletionService.ts:17` 全量遍历恢复行，同步 inspect/rename/unlink 并逐项清 journal。暂存引用分别在 `videoPendingScrapeService.ts:46` 和 `actressIdentityConflictWorkflow.ts:134` 全量取出，`mediaAssetStore/download.ts:276` / `:377` 同步枚举目录、stat 和递归 rm。成本取决于待恢复/暂存数量，不是每次启动遍历全部封面目录。

退出 `appMain.ts:246` stop scheduler，只清调度计时器（`automaticScanScheduler.ts:57`）；`:248` 至 `:261` dispose 列表没有 scanCoordinator 的 cancel+await，也没有 batch queue 的 pause+await。helper dispose 并不等价于证明扫描/目标交割已经退出。长期任务增加碰到关闭时序的机会；这里只指出缺少显式 drain，未复现 closeDatabase 竞态。

**已有缓解。** 暂存引用目录受保护且默认 24 小时安全年龄（download `:19`、`:281`、`:383`）；pending deletion 区分 prepared 恢复和 committed 删除，unknown 保留失败记录；启动恢复 interrupted scan，批量任务恢复 paused；启动扫描延迟 30 秒并串行到期任务，非打开窗口立即强制并行全扫。

**建议/正确性。** 必要一致性恢复与可延后的垃圾回收分开，清理异步、有预算、断点可续；prepared 恢复若尚未完成则锁住受影响操作，不为抢首窗而暴露错误文件状态。统一关闭先阻止新任务、取消扫描/规划、暂停刮削、await 安全交割、持久化再关库。尚有活跃资源写者时不能后台清理其暂存。

**验收。** 0/1k/10k 恢复项分别测到 createWindow 的后台阶段时间；非关键垃圾清理不位于首窗关键路径。每个扫描阶段、NFO planning/apply、刮削 checkpoint 窗口中注入退出，确认无关库后写入、无丢失引用、重启状态可解释；sleep/resume 不启动重叠扫描。

## BG-13：图像解码及插件资源缓存的有条件风险

**图像证据。** `apps/desktop/src/main/services/mediaAssetStore/imageBytes.ts:46` 可用性检查用同步 nativeImage.createFromBuffer，`:125` 取尺寸又优先解码；`mediaAssetStore/download.ts:145` 拉图后检查，再写盘，再 `:154` 读回取尺寸，失败才回退内存缓冲。批量导入中可能对同图重复读/解码。成本为压缩字节和像素规模，不只图片张数。`nfoCoverArtwork.ts:31` EXIF 非默认方向有逐像素复制，`:73` 规划解码/编码，执行 `:103` 可能再次转换；这是现有准确尺寸与不可变 recipe 合同的成本。

**缓解与建议。** `inspection.ts:37` 有签名 inspection cache（256 项）；普通 metadata 列表不应该调用 FS 探活，遵循资产边界 ADR。远程 renderer 图片走 `remoteImageFetch.ts:15` 和 `publicHttpFetch.ts:348`/`:361` 的声明长度及流式累计上限；本地 NFO/图片也有字节上限。字节上限不等于像素上限。复用本次下载的尺寸/指纹，头部取尺寸和完整可用性解码职责分开，解码移有界 worker/utility，设置像素/输出字节预算；不能用只看 magic bytes 取代必要有效性判定。

**插件缓存证据。** `apps/desktop/src/main/scrapers/scraperResourceCache.ts:43` memory Map 没有独立 LRU；`:175` 每次 commit 重新 readdir+stat 全 plugin `.bin` 文件。K 个小 URL 首次逐次入缓存可产生 O(K²) 文件计数检查；304 在 `:75` 也走 commit，`:160` 重写 body。不同插件的 Map 没有总内存上限，但 `:188` 有每插件 64 MiB 磁盘配额、单项 16 MiB（`:82` 默认常量），因此不能声称一个固定插件正常写入会无限累积任意字节。`scrapeBrowserImageCache.ts:7` 另有 96 项/200 MiB 缓存；这不是 media:// 的缓存。插件运行在 Worker、有 timeout 和 signal，结束会等 active RPC（`scraperPluginSandbox.ts:241` 至 `:275`），也不等于批量队列已经传递用户取消。

**建议/验收。** 插件缓存使用原子维护的配额账本、全局有界 LRU和 URL in-flight 去重，304 只更新验证元数据；保留按插件串行 commit、ETag 与 staleIfError。测试多小 URL 的 stat 调用数线性增长，缓存总 RSS 有预算；固定大资源 URL 重复命中零网络/零正文写盘。图像路径测每图读取/解码次数，预期正常下载后无需重新读同图取尺寸；极大像素图片可控失败而非占满主进程。此项依插件/图像使用模式触发，不推定所有 30 万影片每次都发生。

## BG-14：Agent 长任务日志与历史的重复全量处理（补充）

**代码证据。** `apps/desktop/src/main/services/pluginDevAgent/workLog.ts:51` 不限条数追加 session.workLog；`apps/desktop/src/main/services/pluginDevAgent/pluginDeveloper.ts:428` 每个领域事件追加 workLog、写 journal，再 `:447` 写产品状态；`toProductState` 在 `:206` structuredClone 全部 workLog，`apps/desktop/src/main/agent-platform/agentRunStore.ts:220` JSON 序列化后更新。若一个任务累计 H 个同量级领域事件，此支路累计日志拷贝/序列化 O(H²)，并非仅追加 O(H)。插件 snapshot `pluginDeveloper.ts:1139`/`:1166` 和元数据 snapshot `agentMetadataCollection.ts:477` 为得到末尾 seq 读取整段 journal；`agentRunStore.ts:315` 支持 afterSeq，却没有 LIMIT，这些调用不传游标。插件 snapshot 还同时复制 workLog 和提取 events（`:1174`），最终经 `apps/desktop/src/main/ipc/pluginDevHandlers.ts:61` 返回。长历史会放大每次状态读取的主进程成本，不依赖 UI 是否虚拟化。

平台 `agentRunStore.ts:401` 每个 durable observation 写 journal，message/tool completed 额外写 audit 与 safeStorage 加密 recovery frame。`readExecutionHistory` 在 `:463` 全量读取、逐帧同步解密/parse/hash；**仅 checkpoint open 失败并满足恢复条件时**才由 `apps/desktop/src/main/agent-platform/agentExecution.ts:193` 至 `:205` fallback 触发，不是每次正常恢复都全解密。不要从此推断每帧都保存完整对话，也不把模型上下文 compaction 等同于数据库历史回收。`apps/desktop/src/main/services/agentMetadata/activityTimeline.ts:196` 的 256 上限只会删 action，保留全部 reasoning；`:51` snapshot clone 全数组，collection `:254`/`:290` 继续复制产品状态，因此长期轮次仍累积。

**已有缓解、建议和验收。** 插件 tool.progress 不持久化（pluginDeveloper `:555`），reasoning 单条有字符截断；元数据 live 通知已有 60 ms 合并且仅发 runId/revision（collection `:295`、`:120`），并非每 token 写 SQLite。应将 workLog 以追加表/流为真相、产品状态只存摘要和游标；cursor 用末尾索引查询，日志分页；恢复采用经完整性验证的 checkpoint+有界增量流，不能丢工具副作用账本或改变 recovery generation 保护。用 1k/10k/100k 合成事件验证：持久化总字节近线性，snapshot 默认 ≤500 条，取 cursor 不 parse payload；恢复保持 hash、codec、安全存储与副作用对账，测最长同步段及峰值内存。不删除用户要求保留的历史，只改变存储和访问方式。

## BG-15：Agent 历史归档与启动恢复规模（补充）

**代码证据。** `agentRunStore.ts:661` closeRun 只标 closed；`pluginDeveloper.ts:1596` retire 逐任务 close、删 session、`pluginWorkspace.remove`，后者 `apps/desktop/src/main/services/pluginDevAgent/pluginWorkspace.ts:333` 同步递归 rm。`:1615` clearHistory 与 `:1630` discardUnrecoverableSessions 均走该链。因此插件工作区确实被删除，不能说“清理完全没有作用”，但 agent_runs/journal/execution_history/artifacts 等数据库历史仍保留；本次生产代码检索未找到这些表的 DELETE/按年龄回收实现，注释所称 retention policy 不能算已执行的保留上限。持续新建/关闭任务的 DB 历史字节随累计事件/产物增长；实际 GB 增量未测。

启动三个产品恢复入口分别调用 `listRecoverableRuns`（`pluginDeveloper.ts:985`、`apps/desktop/src/main/services/libraryCuratorAgent/libraryCurator.ts:256`、`agentMetadataCollection.ts:498`），平台方法 `agentRunStore.ts:202` 对全部 status≠closed 的 run 做 `.all()` 并解析配置和产品状态，产品随后才按 useCase 过滤。M 个未关闭任务的完整状态被重复加载；已 closed 的历史不会进入此数组，区别于数据库总历史增长。元数据 ready 草稿还需恢复，不能只按 running 过滤。

**建议、约束和验收。** 平台增加按 useCase/status 的窄投影分页，首窗前只恢复必要锁/当前任务；详细历史按需加载。明确可配置历史保留/归档策略、磁盘用量统计与分批回收，不在正常 close 时擅自删除仍需审计或恢复的 history/artifact。插件工作区删除采用异步有界清理，任务已关闭但目录未删成功应可重试。用 0/1k/10k settled/ready/closed 混合任务验证启动载入行数只等于所需集合、单页有界、跨产品不重复解析大 productState；归档不再同步递归删大目录。验证保留期限后磁盘增长受策略控制，同时 active/waiting_user/ready 引用和工具审批/幂等账本不误删。

## BG-16：Agent 大附件元数据工作（补充）

**代码证据与缓解。** 当前 `agentMetadataCollection.ts:304` 是单 target 采集，`draftService.ts:276` 是单 draft 应用，不能虚构一个自动遍历 30 万影片的 Agent bulk API；普通全库刮削仍见 BG-06。单个候选附件也可以很重：`apps/desktop/src/main/services/agentMetadata/draftService.ts:400` 构建 requests/pending，`:444` 最多 320 张，`:451` 单张 20 MiB，`:453` 累计 200 MiB 后停止，`:458` 将每个 Buffer 保留至下载循环结束；然后 `:465` 一次同步 stage 全部，再 `:482` 读回每张计算 SHA-256。总体 O(附件总字节+像素)，**有界但预算较大**，还有当前一张下载及解码缓冲峰值；串行 fetch 和每项 signal 检查已存在，不是无约束 Promise.all。输入 JSON 有 1 MiB 限制（`:214`）。

预览 `:517` 走 `assertResourceIntegrity`，`:934` 按 manifest 缓存验证避免同草稿重复读取；apply `:288` 强制重建 review 并校验全部附件。这是防止暂存被更改的正确性保障，不能因缓存而省掉应用前验证。200 MiB 下载缓冲预算也不是整个进程 RSS 上限，且不限制累计草稿/历史磁盘量（BG-15）。

**建议/验收。** 在候选暂存事务编排内逐图下载→验证→暂存→释放 Buffer，提前从原 Buffer 算 hash/尺寸，持久 manifest 支持失败清理；解码和强制校验有界异步执行，最终引用交割继续守 revision、reviewToken、幂等 outcome、冲突转 pending。用 320 张且逼近 200 MiB 的合成候选测峰值 Buffer/external/RSS，目标常驻下载缓冲只随并发张数变化；取消后暂存无遗漏、已提交草稿仍可读，应用前替换文件仍被拒绝。多次候选采集的增长与 GC 以草稿/历史数量计，不以影片总数臆测。此项与 BG-13 解码和 BG-15 保留策略共同实施。

## 实施顺序与量化验证计划

以下是建议验收目标，不是已有测试结果，也不是对全部 HDD 的既定 SLA。

| 阶段 | 交付 | 主要依赖与验收 |
|---|---|---|
| 0：可观测性 | 阶段计时、FS/DB 调用计数、checkpoint 字节、IPC 计数、事件循环延迟、heap/external/RSS | 用独立合成目录/测试 DB；记录硬件、Electron 版本、盘位、冷/热缓存与采样方法 |
| 1：低语义风险修正 | BG-01 大数组展开、BG-03 pending Set、BG-11 时间节流、BG-02 所有循环让步 | 输出小规模等价；300k 清单无参数溢出；连续事件上限与 final flush |
| 2：主进程 I/O | BG-07 异步缓存出图、BG-02 探测缓存/取消、BG-05 NFO 尾部取消 | 在途数量/字节上限；HDD 热/冷分测；不破坏根验证/加密/图像失效 |
| 3：持久任务数据 | BG-06 targets/checkpoint 分离、BG-08 alias 增量与恢复日志 | 总序列化/写入量从平方降线性；崩溃窗口故障注入通过后再迁移旧格式 |
| 4：全库任务流式化 | BG-01 扫描索引、BG-04 审计/清理、BG-09 分页规划与结果 | 全局同番号/目标冲突仍正确；主进程内存有界；事务内无批量 FS |
| 5：长任务维护 | BG-10 迁移、BG-12 生命周期、BG-13 cache/decode | 所有阶段可观测、可停在安全点、可解释恢复，保留必要校验 |
| Agent 并行工作包 | BG-14 日志/游标、BG-15 归档与恢复、BG-16 附件流水处理 | 先取游标与追加日志去平方，再做有界附件和可配置保留；必须保留恢复/审计语义 |

测量矩阵应包含 10k/100k/300,382/600,764 文件或目标四档；普通视频、STRM、NFO 开/关；一根大目录、多级目录、重复番号；已知时长/未知时长/待确认；封面 0% 与约 24% 缺失（后者仅用于模拟工单陈述）；明文/密文；导出仅 NFO 与全部附件；同 HDD/跨盘搬迁。没有必要真实下载 30 万部影片：路径/DB 合成验证复杂度，少量真实容器和图片加延迟 I/O 验证读写行为，Windows HDD 单独测吞吐。

推荐交互保护目标：后台任务期间主进程 event-loop delay p99 ≤100 ms、最长连续同步段 ≤250 ms；取消请求在 1 秒内进入“正在停止”，允许当前原子交割完成，但必须分别记录停止请求确认与实际结束延迟。异常设备系统调用没有可保证的固定时限，应以进程隔离/超时和可恢复状态处理，不能用目标值掩盖实际挂起。若某环境未达标，报告实值和阶段瓶颈，不以总任务耗时下降代替响应性验收。

对 N+1 和平方循环优先计数，再测时间：例如 T 翻倍时 checkpoint 字节增长约 2 倍；F/P 翻倍时审计 Set 构建与查找次数近线性；每页导出附属查询为固定表种类数量。计数能在无用户数据下验证实现是否真正改掉复杂度，绝不能把这些推导当成“已快了多少倍”。

正确性回归优先复用 `scanner.test.ts`、`scanCoordinator.test.ts`、`videoDuration.test.ts`、`checkpointedSequentialBatchQueue.test.ts`、影片/演员 batch queue 测试、`mediaAssetStore.test.ts`、`assetCache.test.ts`、两种资产迁移测试、NFO module/controller/safety/profile/cover 测试和 `automaticScanScheduler.test.ts`。仅在实现改变对应边界后运行相关测试与合成规模检查，再按仓库要求扩展；本次是分析文档任务，未运行全套测试或启动应用。

## 尚未验证与跨审计接口

- 未获取用户 DB、原影片或 HDD；没有本机/目标机性能 benchmark。当前结论为源码已证成本结构与风险，运行故障/耗时须按上述方案验证。
- 后台 repo 的索引、query plan、SQLite page/cache/WAL 参数由数据库主审处理；本报告的分页 hydrate、审计落盘和任务 journal 方案须与其协调，避免多套连接/状态规则。
- UI 主审决定订阅与列表失效策略；后台可先减少 progress 发包，不应擅自删除 UI 依赖的状态通道。协议缓存也需同步明确图片 URL 版本语义。
- 启动数据库 migration/bootstrap 的内部成本和 Web catalog 查询不在本报告范围；按补充要求，Agent 平台历史、插件归档、元数据附件规模已核查到具体读写链（BG-14 至 BG-16），未扩展为 MCP 全面审计。
- 仅指定本文件为本次产物；未修改其他审计者拥有的报告或生产代码。
