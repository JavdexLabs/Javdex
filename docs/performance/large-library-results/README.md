# 合成大库基准原始结果

2026-09-11 最新执行：用户随后授权高频读取、worker和清理三项优化，本地全量2850通过/1跳过/0失败，见[DF报告](../large-library-high-frequency-cleanup-results.md)及[本轮证据清单](implementation/batch-df-manifest.json)。

历史收尾：DD/DE NFO优化及计划更新完成后按用户要求停止。245联合测试、全量2813通过/1跳过、构建通过；[最终证据清单](implementation/batch-de-manifest.json)、[当前源码快照](implementation/batch-de-nfo-workset.patch)、[完整待办矩阵](../large-library-optimization-plan.md#12-收尾范围与完整待办矩阵)。以下批次与基准保留为历史，不把早期“UI待接入/下一步”等文字视为当前状态。各patch通常为相对基线的累计选取，不能逐个当独立补丁应用。


基线：`4c953a960d910aed3fb102b39a337b418c6292f9`，审计日期 2026-09-10（JSON 中时间为 UTC）。

- `10000-default.json`：10,000 影片，未执行 ANALYZE；最初记录版本没有 `analyzed` 字段。
- `10000-analyzed.json`：同样的生成规则，执行 ANALYZE。
- `300382-analyzed.json`：300,382 影片，执行 ANALYZE。
- `300382-experiments.json`：同规模，执行 ANALYZE；隔离 SQL 变体及结果等价断言。包含真实 better-sqlite3 SQLite 版本和编译选项。

- `300382-startup.json`：独立 startup profile，已为 schema 15 的库执行迁移入口/全库外键校验；不等同完整启动。pragma 不经过 prepare 代理，因此 SQL 计数为 0，函数时间仍包含校验。
- `array-expansion.json`：同 Electron 环境隔离执行 `files.push(...rootFiles.map(x => x))` 的规模边界；不是数据库或完整扫描测试。

数据库基准全部使用临时合成库，结束后删除；没有访问用户库。使用真实仓库 repo/API 函数，以代理记录 SQL、参数、EQP 和耗时。未更改生产查询或正式 schema。最后两个 overlap 用例才新增第二媒体库及三分之一影片重叠，不能把最后的数据库体积视为全部单库用例执行时体积。

机器为 Apple M4 / arm64 / 16 GiB，Electron 43.4.1。实际 SQL 引擎由 `SELECT sqlite_version()` 确认为 **3.53.4**；`process.versions.sqlite=3.53.1` 属于 Node 内置 SQLite，不能当作 better-sqlite3 的版本。实际 PRAGMA：WAL、synchronous=1、cache_size=-16000、mmap_size=0、temp_store=0、busy_timeout=5000、user_version=15。前三份没有独立记录 SQL 引擎版本，第四份在相同依赖环境中补测，不能声称前三份 JSON 自带该字段。

每个场景首次执行一次，再执行 3 次取热运行中位数和最大值。首次执行受建库和操作系统缓存影响，不是冷盘数据；3 个样本不能推算 p95。不同 profile 是不同临时库，非同一 Windows/HDD 实例；部分独立进程测量时间重叠，可能有 CPU/I/O 争用，不能将小幅差异当作收益。秒级趋势及计划改变应在目标机器复核。

`serializedBytes` 是函数结果 `JSON.stringify` 的字节数，用于衡量传输量代理；不是实测 Electron IPC 序列化耗时。`rssBytesAfter` 是用例结束时进程 RSS，包含建库及此前结果的分配，不是峰值或该用例增量。`sqlMsLast` 是最后一次调用的 SQL 时间，不是中位数。EQP 在计时外读取。

数据：每部影片 128 字节简介、2 条演员关系、4～5 条标签关系、1 条合成直连资源，无真实媒体文件、无海报/剧照、无复杂分类/积压任务；大库中 10,000 演员、1,000 标签、1,301,655 标签关联；清单最多 30,000 条。额外重叠库后大库约 414.57 MiB，**并非用户的 1 GB 数据库，也不覆盖全部高扇出情形**。

## 重跑

仓库根目录先 `npm ci`。以下是 POSIX shell 示例；PowerShell 使用 `$env:变量名='值'` 设置同名变量，执行后清除。

```sh
JAVDEX_BENCH_VIDEOS=10000 JAVDEX_BENCH_OUTPUT=/tmp/10000-default.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
JAVDEX_BENCH_VIDEOS=10000 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_OUTPUT=/tmp/10000-analyzed.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
JAVDEX_BENCH_VIDEOS=300382 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_OUTPUT=/tmp/300382-analyzed.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
JAVDEX_BENCH_VIDEOS=300382 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_PROFILE=experiments JAVDEX_BENCH_OUTPUT=/tmp/300382-experiments.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
```

仅复跑启动校验可在上述大库命令中增加 `JAVDEX_BENCH_PROFILE=startup`。当前脚本默认也包含该场景；前三份历史结果生成时尚未加入，因此独立保存补测，不补造旧结果。

完整大库缺统计的相关聚合可能极慢，因此超过 10,000 条时脚本要求显式选择 `ANALYZE=1` 或 `PROFILE=core`；core 跳过标签、演员、Web 和首页聚合，不应标为完整覆盖。`JAVDEX_BENCH_SAMPLES` 控制 1～20 次热运行，默认 3。测试 runner 默认 180 秒超时，可通过 `JAVDEX_TEST_TIMEOUT_MS` 调整；外部强杀不保证 finally 清理临时目录，发生超时后只清理该次 `javdex-library-bench-*` 合成目录，不能对应用数据目录操作。

基准不是日常 `npm test` 自动执行项；不设跨机器绝对性能断言。SQL 实验包含当前合成数据的结果等价断言，但不能替代隐藏/归档/冲突/混合筛选等正式回归。

## 批次 AA：当前实现的统计维护探针

上述原始基线保持不变。新工作区的分析见[统计维护与标签复核](../large-library-statistics-probe.md)，结果为 `implementation/batch-aa-*.json`，当前数据库 schema 为16。

```sh
JAVDEX_BENCH_VIDEOS=10000 JAVDEX_BENCH_STATS_PROBE=optimize JAVDEX_BENCH_OUTPUT=/tmp/statistics-optimize.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
JAVDEX_BENCH_VIDEOS=10000 JAVDEX_BENCH_STATS_PROBE=analyze JAVDEX_BENCH_OUTPUT=/tmp/statistics-analyze.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
```

探针不能与 `ANALYZE=1` 或裁剪 profile 混用，当前规模上限为10k。分别比较单库25项、重叠库写入后重新采集的27项完整返回值，并记录各自维护前后 EQP。结果相同不代表性能目标达成；调用 optimize 也不保证每次重新分析全部表。没有生产维护钩子。`before-query-fix` 是历史诊断输出，第二阶段只有两项；最终两份探针才包含25/27项。

后续AC在主脚本增加两个selected-label用例，当时脚本完整probe矩阵为27/29项；AA/AB结果保留当时25/27项，不能改写历史。AC独立运行了300382有统计完整基准，见 `implementation/batch-ac-labels-300382.json`；该运行没有执行统计probe。


## 批次 AD：手工标签分页候选

主脚本新增首屏、搜索和深页三项候选查询，当前完整统计probe矩阵为30/32项；AD运行下列两组有统计基准（每组32项），没有重新运行统计维护probe。历史结果数量保持原样。

```sh
JAVDEX_BENCH_VIDEOS=300382 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_OUTPUT=/tmp/options.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
JAVDEX_BENCH_VIDEOS=300382 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_MANUAL_SPARSE=1 JAVDEX_BENCH_OUTPUT=/tmp/options-sparse.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
JAVDEX_TAG_PICKER_UI_OUTPUT=/tmp/picker-ui node scripts/performance/manual-tag-picker-ui.mjs
```

稀疏模式仅将video_id为100倍数的关系保留为manual。浏览器脚本使用真实组件和全局样式、模拟IPC，验证1000×640和1440×900；不代表原生Electron或用户库端到端验收。结果与限制见[实施记录](../large-library-implementation-status.md)。


## 批次 AE：临时覆盖索引与聚焦回退控制

`JAVDEX_BENCH_INDEX_PROBE=tag-origin`在完整、有统计的合成库上比较候选索引，单库30项/重叠32项；不与统计维护probe或裁剪profile混用。可选`JAVDEX_BENCH_CASE=legacy.release`仅作单场景诊断，追加恢复原索引后的A-B-A控制，不代表完整矩阵；只接受单库已有case，错误名称会拒绝。`tag-index-benchmark.ts`另支持`JAVDEX_TAG_BENCH_INDEX=tag-origin`，最终新增命中搜索与非空浅页，每组34条记录。详见[报告与复现命令](../large-library-tag-origin-evaluation.md)及`implementation/batch-ae-manifest.json`。

AE保持生产索引/schema16不变。它证明稀疏候选的覆盖查询收益，不代表已完成正式迁移、生产统计维护或Windows/HDD验收。


## 批次 AF：正式迁移后的基准

工作分支当前schema17，前述schema16说明属于历史批次。`JAVDEX_BENCH_MIGRATE_FROM=16`恢复临时库旧索引/版本后执行真实迁移；不能与索引、统计或裁剪profile混用。首次startup测量包含实际迁移，warm值只是重复的当前版本入口；输出前还关闭并只读重开核验索引和完整性。

```sh
JAVDEX_BENCH_VIDEOS=300382 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_MANUAL_SPARSE=1 JAVDEX_BENCH_MIGRATE_FROM=16 JAVDEX_BENCH_OUTPUT=/tmp/migration-v17.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
```

ANALYZE在迁移前执行，单库查询不重新分析新索引；原有overlap阶段才再次ANALYZE。该模式32项，不是索引探针的30/32项结果差分。普通基准使用当前覆盖索引；历史索引实验则显式重建pre17窄索引作为对照。


## 批次 AG：标签筛选分页

主基准新增`tags.filter_options`、搜索及offset900三项，普通完整运行35项；完整probe矩阵现为33/35项。AG只运行300382有统计普通矩阵，历史统计/索引探针数量保持不变。`JAVDEX_TAG_FILTER_UI_OUTPUT=/tmp/filter-ui node scripts/performance/tag-filter-ui.mjs`运行真实父筛选弹层的Chrome夹具，模拟IPC；截图等待进入动画结束并滚到分页区，不代表原生Electron整页导航。结果见`implementation/batch-ag-manifest.json`和[实施记录](../large-library-implementation-status.md)。


## 批次 AH：筛选候选缓存

主脚本新增`tags.filter_options_cached`和`tags.filter_options_invalidated`，普通完整运行37项；当前完整probe为35/37项，历史结果保持原计数。缓存用例首次为服务miss，后续为hit；失效用例每次UPDATE同一标签为原值，保持查询结果但真实推进SQLite写修订，耗时包含该写入。它只修改脚本创建的合成库。sqlCalls不包含PRAGMA，但总耗时包含修订检查。结果和缓存边界见[实施记录](../large-library-implementation-status.md)及`implementation/batch-ah-manifest.json`。


## 批次 AI：原生reader worker探针

```sh
JAVDEX_READER_PROBE_OUTPUT=/tmp/reader-worker.json node scripts/run-electron-tests.mjs scripts/performance/catalog-reader-worker-probe.ts
```

使用临时目录、实际只读连接工厂、开发依赖esbuild和当前Electron原生SQLite。对同一合成CPU查询比较worker与主线程定时器响应；不是生产IPC、打包或真实大库性能验收。消息窗口及定时器计量范围详见结果caveats和[实施记录](../large-library-implementation-status.md)。


## 批次 AJ：实际标签worker与ASAR

先运行`npm run build`，再独立顺序运行（不要与类型检查/构建并行）：

```sh
JAVDEX_WORKER_BENCH_OUTPUT=/tmp/catalog-worker.json node scripts/run-electron-tests.mjs scripts/performance/catalog-worker-benchmark.ts
JAVDEX_ASAR_PROBE_OUTPUT=/tmp/catalog-asar.json node scripts/run-electron-tests.mjs scripts/performance/catalog-worker-asar-smoke.ts
```

实际生产worker/client及30万合成目录测量首次、命中、提交后的失效查询和主线程定时器间隔。失效写入真实改变影片时间戳，标签结果不变；结果逐次比较。ASAR脚本用构建入口/共享chunk及native模块启动无窗口Electron，临时profile和临时数据库均清理。它不是最终安装包或完整应用IPC验收；原生长查询终止仍有缺口。最终原始结果、45项定向、全量/构建及审查见`implementation/batch-aj-manifest.json`和[实施记录](../large-library-implementation-status.md)。


## 批次 AK：排队期限与最终复测

运行命令沿用AJ。新增逐订阅排队超时后，重新执行完整套件、构建、ASAR及独立30万worker基准，见`implementation/batch-ak-manifest.json`。`before.log`为缺少期限的失败证据，不能当作当前失败；完整回归2,187通过、1跳过。30秒为排队期限，原生终止和dispose仍无硬保证。


## 批次 AL：待确认刮削概要与详情

```sh
JAVDEX_PENDING_BENCH_OUTPUT=/tmp/pending.json node scripts/run-electron-tests.mjs scripts/performance/pending-scrape-benchmark.ts
JAVDEX_PENDING_UI_OUTPUT=/tmp/pending-ui node scripts/performance/pending-scrape-ui.mjs
```

基准创建1万待确认、每条1候选和4KiB简介，三次顺序测量旧全量hydrate、首50概要、深链接页和单项详情；与构建/类型/其他基准隔离。计时不含JSON序列化与结果断言，载荷是JSON等价字节。旧路径先跑，不能用后续RSS推断新路径独占内存。浏览器脚本使用真实页面/路由/样式及固定高容器，模拟IPC，验证50项分页、重试、页眉与分页可达、每页单次详情。历史全量审计路径仍保留在设置页，不是整个应用消除所有待确认全量读取。见`implementation/batch-al-manifest.json`和[实施记录](../large-library-implementation-status.md)。


## 批次 AM：审计页存在性查询

```sh
JAVDEX_AUDIT_UI_OUTPUT=/tmp/audit-ui node scripts/performance/audit-presence-ui.mjs
JAVDEX_PENDING_BENCH_OUTPUT=/tmp/pending-presence.json node scripts/run-electron-tests.mjs scripts/performance/pending-scrape-benchmark.ts
```

pending基准现有5项，新增100个ID存在性lookup；AL历史4项不改写。Chrome实际审计组件/样式、模拟IPC验证201项分页为100/100/1、读取失败/重试、全部文件到异常第201项的真实focus/scroll和两种尺寸。它不代表原始审计数组已分页、完整settings启动或Windows性能。最终证据见`implementation/batch-am-manifest.json`与[实施记录](../large-library-implementation-status.md)。


## 批次 AN：三类待办合并查询

运行命令沿用AM。pending基准现有6项，并在1万刮削记录之外加入1万扫描组/1万身份，新增`audit.presence.mixed100`（总数100，完整结果等值断言）。夹具规模有变，不与历史AL/AM数字作直接回归归因。审计浏览器脚本新增group-delayed旅程：hold查询到RAF后，检查真实焦点group201、无待办动作，再释放并验证路由；`finalAnchor`仅代表行标识。两尺寸共4组结果见`implementation/batch-an-manifest.json`和[实施记录](../large-library-implementation-status.md)。


## 批次 AO：扫描/身份队列分页

```sh
JAVDEX_SCAN_BENCH_OUTPUT=/tmp/scan-queue.json node scripts/run-electron-tests.mjs scripts/performance/pending-scan-benchmark.ts
JAVDEX_SCAN_UI_OUTPUT=/tmp/scan-ui node scripts/performance/pending-scan-ui.mjs
JAVDEX_PENDING_UI_OUTPUT=/tmp/scrape-ui node scripts/performance/pending-scrape-ui.mjs
```

独立基准包含1万组/组内2资源且显示名4KiB、1万身份，3次热样本；概要首50与深身份页完整DTO等值断言。全量旧路径先测，Repo计时排除JSON/断言。50项概要有界不等于count/rank/排序/OFFSET恒定成本，也不限制单组详情资源数。两种尺寸真实React页面/路由/样式验证扫描与刮削分页，IPC为模拟；不冒充原生/Windows验收。最终证据见`implementation/batch-ao-manifest.json`与[实施记录](../large-library-implementation-status.md)。


## 批次 AQ：演员维护检查复用

```sh
JAVDEX_ACTRESS_MAINTENANCE_OUTPUT=/tmp/actor-maintenance.json node scripts/run-electron-tests.mjs scripts/performance/actress-conflict-maintenance-benchmark.ts
```

同一实现对比“真实probe写入失效 → 连续未变化 → 再失效”，每段3热样本，1万pending、4KiB JSON文本、已存在1万冲突。计时排除probe写入与断言，所有summary字段完全相同。复用检查标记只省掉未变化时的一致性维护，聚合仍执行；发生repair写入时不能缓存，必须保留下一遍补冲突语义。不是旧构建基准或Windows验收。另恢复AP中被误覆盖的两项原hook测试；不要将AP最终源快照当作完整回归覆盖，见本批实施记录。


## 批次 AR：演员概要页／单组 API（UI待迁移）

```sh
JAVDEX_ACTRESS_QUEUE_OUTPUT=/tmp/actor-queue.json node scripts/run-electron-tests.mjs scripts/performance/actress-conflict-queue-benchmark.ts
```

当前基准为100组，全部冲突名由一个有100别名的演员持有，每pending含4KiB JSON。3热样本，legacy comparator关闭字段预览；单组get另与默认完整legacy结果对照。原1000组脚本整体180s超时，无阶段数据，不能归因为某一个查询；源快照与失败日志保留于AR清单。需重现时将该源快照复制回`scripts/performance/actress-conflict-queue-benchmark.ts`（相对导入依赖原目录），不要直接在结果目录运行。当前脚本增加阶段日志，结果不能外推大规模或实际UI收益。
