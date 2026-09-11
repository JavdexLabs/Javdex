# 标签关系分布与覆盖索引评估（批次 AB）

后续AD候选接口的tag-origin覆盖索引及全矩阵控制实验见[AE报告](large-library-tag-origin-evaluation.md)；本文保留AB的计数查询对照。

接续[统计探针 AA](large-library-statistics-probe.md)，属于 PERF-04。当前生产变更只把手工标签存在性判断从关联 EXISTS 改为非关联 IN 集合，没有新增正式索引或数据库迁移。

## 查询修复与取舍

AA 的 EXISTS 在倾斜数据上仍有坏计划：1,001 个标签中只有4个有关联，10,000影片、每影片4条关系、约1/7为manual时，ANALYZE后 SQLite 对每个外层标签使用 `idx_video_tag_origin(origin=?)`。大量没有关系的标签也反复扫描全部manual关系。

改为 `t.id IN (SELECT tag_id FROM video_tag WHERE origin='manual')` 后，手工标签集合只构建一次。重复关联不会重复返回标签；可见计数仍由已有 INNER JOIN 聚合提供，隐藏/归档-only manual 标签仍保留零计数。

下表为同生成规则、不同隔离进程的三次热运行中位数。取候选索引添加前、完整ANALYZE后的查询时间；旧、新查询源快照和原始结果分别保存，不能用当前脚本自身的 baseline 字样推断旧查询。

| 影片数与关系分布 | AA EXISTS（ms） | AB IN（ms） |
|---|---:|---:|
| 10,000，全manual、均匀 | 9.05 | 12.20 |
| 10,000，约1% manual、均匀 | 6.25 | 2.28 |
| 10,000，四个热门标签 | 546.08 | 7.34 |
| 300,382，全manual、均匀 | 338.94 | 436.38 |
| 300,382，约1% manual、均匀 | 275.60 | 80.37 |

这是消除重复扫描的取舍，**不是所有分布都加速**。密集均匀场景为构建集合多扫描一次manual关系，在本夹具增加约97ms；后续通过覆盖索引或复用计数减少这部分成本。旧倾斜计划已经在10k暴露，未继续强跑300k旧查询；保护检查在建库前阻止该组合。验证10k新查询后才显式放开大倾斜夹具，新查询300,382影片为268.34ms，不是旧查询大库的前后对照。

## 覆盖索引候选

两个候选只在临时库创建：

- video-first：新增 `(video_id, origin, tag_id)`，保留现有origin索引。
- origin-first：用 `(origin, video_id, tag_id)` 替换窄origin索引，保留以origin为首列的查询能力。

每个候选独立建库，先测当前IN查询，再创建候选、比较完整结果和EQP，最后完整ANALYZE并再测。候选创建后、ANALYZE前仍保留原统计，不叫“完全无统计”。每次还执行1,000新增、1,000来源更新、1,000删除，分三次事务提交，最后核对结果、外键和完整性。

300,382影片，新增候选并ANALYZE后的手工计数：

| 分布 | 无候选（ms） | video-first（ms） | origin-first（ms） |
|---|---:|---:|---:|
| 全manual、均匀 | 436.38 / 434.82 | 303.83 | 323.00 |
| 稀疏manual、均匀 | 80.37 / 80.95 | 90.47 | 89.52 |
| 四个热门标签 | 268.34 / 269.59 | 126.11 | 123.38 |

无候选栏两值分别来自两个候选的独立基准，不能视为单库同时对照。空间按 `(page_count-freelist_count)*page_size` 比较，video-first增加约24.7～26.2MiB，origin-first净增约4.0～5.4MiB。它们是整库已用页差额，不是物理设备写入量。

全manual场景三事务写入探针：video-first由3.19ms变为4.28ms，WAL文件长由436,752变为758,112B；origin-first由3.06ms变为3.36ms，WAL文件长变为646,872B。单次事务样本不能证明稳定写入回归百分比，但足以说明不能把新索引当作无成本优化。

## 落地决策

1. 保留IN修复，消除已确认的倾斜坏计划；使用既有语义oracle和统计前后对照验证。
2. **优先继续验证origin-first**：密集/倾斜查询受益，净空间和写入增量小于新增video-first；稀疏查询没有一致收益。正式迁移前还需所有读取与批量写入矩阵、旧schema升级与故障回滚，当前不直接加索引。
3. 标签添加弹窗只用名称却调用完整计数并在页面挂载时预取，应改为按需、分页的窄候选查询；保留准确manual归属、搜索、过期响应保护和错误显示。它与全量计数视图的需求不同，不能为了保留无用字段反复聚合百万关系。
4. 全量计数仍需数据库修订缓存及查询隔离。当前合成查询数百毫秒尚未达到目标Windows交互验收，不以此关闭PERF-04。

## 复跑与证据

脚本：`scripts/performance/tag-index-benchmark.ts`。变量：`JAVDEX_TAG_BENCH_VIDEOS`（1000～300382）、`JAVDEX_TAG_BENCH_DISTRIBUTION=all|sparse|skew`、`JAVDEX_TAG_BENCH_INDEX=video-first|origin-first`、`JAVDEX_TAG_BENCH_SAMPLES`、`JAVDEX_TAG_BENCH_OUTPUT`。只有确认新计划后才为超过10k的skew设置 `JAVDEX_TAG_BENCH_ALLOW_LARGE_SKEW=1`。

原始文件与SHA256映射见[AB清单](large-library-results/implementation/batch-ab-manifest.json)。`before-*` 使用AA EXISTS；`after-*` 使用AB IN；两个版本的源码快照分别保存。所有已执行用例均使用可删除临时库，未访问用户库。文件体积包括空闲页；另记已用页差额。默认首次计时之前已做EQP/结果采集，是热OS查询实验，不是冷启动、p95、Windows/HDD、完整导入或长期稳定性证明。
