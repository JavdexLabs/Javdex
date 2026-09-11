# 手工标签候选覆盖索引与完整矩阵评估（批次 AE）

本文为AE实验记录；后续AF已在工作分支实现schema17正式迁移，实际迁移测量与限制见[实施记录](large-library-implementation-status.md)。下文“未改变生产schema”描述AE当时状态。

当前 `(tag_id)` 索引能定位标签关系，但稀疏manual候选仍需扫描大量关系并回表判断origin。临时替换为 `(tag_id, origin)` 后，30万影片标签专用夹具首屏从212.843ms降到0.274ms，完整大库夹具从242.313ms降到0.264ms。**推荐将此候选纳入正式索引迁移方案；当前仍仅为临时库实验，生产schema16和索引均未改变。**

这是[AD实施记录](large-library-implementation-status.md)中约233ms稀疏查询的后续，不替代[AB计数覆盖索引评估](large-library-tag-index-evaluation.md)。两类索引解决不同访问路径，不能仅凭名称中的origin认为收益相同。AD查询显式使用tag_id索引，AB的origin-first候选不会自动覆盖这条访问路径。

## 对照与证据

保持相同合成影片、关系和返回口径，只替换临时库中 `idx_video_tag_tag_id` 的字段列表；保留以tag_id为首列的查找能力与独立origin索引。比较无统计、基线ANALYZE、候选创建后未重分析、候选ANALYZE四阶段。每阶段读取完整标签计数、manual计数和六种候选用例，另测三事务写入，共34条测量记录。

六种候选为首屏、`Tag 99`搜索、`Tag 1`命中搜索、offset2/limit1非空页、offset900和未命中搜索。每种分布显式断言命中搜索及offset2页非空；稀疏/倾斜的offset900为空，不声称这些分布验证了非空深页。每次比较完整返回值，写入后再次比较，最后执行foreign_key_check和integrity_check。

| 影片数 | 分布 | 原首屏 ms | 候选首屏 ms | 净活跃页增量 MiB | 三事务写入 ms |
|---|---|---:|---:|---:|---:|
| 10,000 | all | 0.054 | 0.043 | 0.23 | 2.686 → 3.377 |
| 10,000 | sparse | 4.592 | 0.163 | 0.27 | 3.039 → 3.355 |
| 10,000 | skew | 0.095 | 0.108 | 0.25 | 3.087 → 3.558 |
| 300,382 | all | 0.055 | 0.051 | 5.39 | 3.156 → 3.620 |
| 300,382 | sparse | 212.843 | 0.274 | 6.53 | 3.389 → 3.945 |
| 300,382 | skew | 0.118 | 0.104 | 7.44 | 3.446 → 3.967 |

all为全manual且均匀；sparse为约1%影片具有manual关系；skew为只有4个热门标签且约1/7影片为manual。每影片4条关系，另有共享、隐藏和归档成员；此专用夹具比主矩阵窄，不能混用绝对耗时。写入包含1,000条新增、来源更新和删除，分三次提交，不是完整导入，也不是写入p95。净活跃页按page_count减freelist_count计算；WAL文件长度与文件大小见JSON，不等同设备物理写入量。

候选EQP显示 `SEARCH vt USING COVERING INDEX idx_video_tag_tag_id (tag_id=? AND origin=?)`，对资格判断无需读取关系表正文。仍需按名称扫描标签，空结果、搜索和深OFFSET总工作量并未成为常量。全量标签计数也没有因此全部达标。

## 完整查询矩阵

扩展主基准，新增 `JAVDEX_BENCH_INDEX_PROBE=tag-origin`。要求完整、有统计模式，不能混用统计维护或裁剪profile。先保存本阶段实际结果，再建候选、ANALYZE、重放每个查询并比较全部返回值；finally恢复原索引并ANALYZE，之后才添加重叠媒体库，重新采集该阶段期望结果。

300382密集与稀疏两份运行均完成单库30项、重叠库32项比较，每份124条测量记录。包含旧/新列表、搜索/排序、标签/演员、Web、首页、清单等脚本现有用例。稀疏首屏单库242.313→0.264ms，重叠238.260→0.278ms。这里的“完整”指现有主脚本矩阵，不是项目所有筛选组合、所有硬件或并发场景。

密集单库 `legacy.release` 出现566.62→676.96ms，超过本次诊断阈值（同时增加10ms和10%）；其他矩阵场景没有同时超过两项阈值。此阈值只用于挑选复测，不是发布SLO。该查询不访问video_tag，前后EQP相同，但不能据此直接排除性能问题。

独立十次热样本复测仍出现473.49→569.62ms，重叠627.40→629.38ms。随后增加同库A-B-A控制：

| 阶段 | 原索引 A ms | 候选 B ms | 恢复原索引 A ms |
|---|---:|---:|---:|
| 单库 | 460.38 | 573.55 | 638.50 |
| 重叠库 | 631.28 | 631.07 | 628.26 |

恢复原索引后单库没有恢复初始速度，重叠阶段三者接近。这说明顺序测量有运行阶段影响，不能将单库差异直接归因为候选索引。A-B-A恢复的是结构和重新生成的统计，不恢复原缓存或物理页布局；尚未确定是缓存、CPU频率或其他环境因素，不能写成“已证明零退化”。下一步在固定热身、交替顺序和目标硬件上复核，不用一次小样本决定跨平台默认值。

聚焦模式为 `JAVDEX_BENCH_CASE=legacy.release`，只支持单库矩阵已有名称；每阶段只比较一项并追加恢复控制，不能混称30/32项。未知case已验证抛错，禁止零比较的假成功。EQP按场景＋SQL保存代表性参数，未捕获计划的语句可能被跳过；不是每次SQL调用的完整trace。原release-recheck属于补控制前诊断记录，release-aba为最终控制证据。

## 正式落地与剩余门槛

1. 设计版本化迁移替换tag_id索引，同步新库schema；保持既有索引名和首列合同，保留origin索引。验证原业务表/行及外键不变，建索引失败后DDL和版本回滚、重试及重复启动幂等。不要仅在启动时执行IF NOT EXISTS，因为同名旧索引不会自动升级。
2. 评估迁移启动时延：主矩阵中建索引加完整ANALYZE约0.9～1.0秒（具体值见indexRuns），是额外同步工作，不能当作已满足后台迁移要求。生产统计维护策略尚未确定，不应机械照搬实验的全库ANALYZE。
3. 继续验证标签查找/剪枝、来源变更、批量写入、级联删除等写路径，以及Windows/HDD、磁盘压力和故障恢复。当前只有本机临时合成库；本批没有运行用户库或修改生产schema。
4. 完成TagFilter按需分页：现唯一父调用在筛选弹层中，关闭会卸载；默认模式仍需显式open准入。新增至多100项的窄候选接口，按名称选页后只计算页内可见影片数，同一短读快照。保留全局active/非隐藏成员计数、共享去重、零计数和所有origin口径；这不是当前媒体库或其他筛选联动计数。
5. 名称分页会改变当前全局计数降序，应在UI标注“按名称”；页内计数排序不得冒充全局计数排序。若必须保留全局计数排序，需要可靠的预计算/修订缓存，简单LIMIT不能消除全量计数。
6. TagFilter测试覆盖跨页选择、100项上限、完整ID身份、Unicode搜索、加载/错误重试、关闭/导航/详情覆盖的旧请求隔离和真实父弹层隐藏请求；内联已选名称独立走useTagLabels，不依赖当前页。

本批改动仅实验脚本与项目报告，未重复运行未改动的生产全量套件；上次AD的2,143通过/1跳过不能算作本批脚本的测试数。本批实际验收为六组专用基准、两组完整矩阵、两次聚焦诊断、未知case拒绝、静态审查与diff检查。脚本执行均以Electron/真实SQLite运行，结果和清单见[AE证据](large-library-results/implementation/batch-ae-manifest.json)。完整15工作包/42风险目标仍未完成。

## 复现

```sh
JAVDEX_TAG_BENCH_VIDEOS=300382 JAVDEX_TAG_BENCH_DISTRIBUTION=sparse JAVDEX_TAG_BENCH_INDEX=tag-origin JAVDEX_TAG_BENCH_OUTPUT=/tmp/tag-origin.json node scripts/run-electron-tests.mjs scripts/performance/tag-index-benchmark.ts
JAVDEX_BENCH_VIDEOS=300382 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_MANUAL_SPARSE=1 JAVDEX_BENCH_INDEX_PROBE=tag-origin JAVDEX_BENCH_OUTPUT=/tmp/tag-origin-matrix.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
JAVDEX_BENCH_VIDEOS=300382 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_INDEX_PROBE=tag-origin JAVDEX_BENCH_CASE=legacy.release JAVDEX_BENCH_SAMPLES=10 JAVDEX_BENCH_OUTPUT=/tmp/release-aba.json node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
```
