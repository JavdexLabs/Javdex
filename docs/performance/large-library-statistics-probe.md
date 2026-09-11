# 统计维护与手工标签查询复核（批次 AA）

本记录补充 [Issue #100 主审计](large-library-performance-audit.md)与[实施计划](large-library-optimization-plan.md)的 PERF-04。代码为当前未提交工作区，基线仍为 `4c953a9`；没有打开用户数据库。历史基线、当前实现和隔离 SQL 实验的数字不能混用。

下文记录AA时点；后续[AB倾斜分布与覆盖索引评估](large-library-tag-index-evaluation.md)发现关联EXISTS在倾斜统计下仍有退化，已改为非关联IN集合。最新实现以实施记录为准。

## 已确认的问题及修复

批次 B 的可见成员预聚合已经改善普通标签，但手工标签为保留零可见计数标签，仍对成员集合使用 LEFT JOIN。1 万影片缺统计夹具上，该查询热运行中位数为 **6,365.76 ms**。这不是只有 30 万库才触发的问题。

当前实现把两个条件分开：INNER JOIN 计算可见 manual 关系数；独立 EXISTS 判断标签是否拥有任意 manual 关系。只存在于隐藏或非活动库的手工标签仍返回零，scraped-only 标签不进入手工列表，共享影片不重复计数。缺统计同规则夹具的新查询为 **10.68 ms**。这是两个隔离进程的同生成规则比较，不是客户数据库的前后测量。

修复前 EQP 为按 `idx_video_tag_origin` 取关系后 `SCAN members LEFT-JOIN`；修复后先枚举 members，再按 `sqlite_autoindex_video_tag_1 (video_id=?)` 查关系，消除了每条关系重复扫描成员集合的计划。仍需构造可见成员和聚合全部关系，工作量没有变成常数。

正式回归另外用 80 影片覆盖共享、隐藏、归档及混合来源，并与独立关联 EXISTS 计数 oracle 比较；无统计、optimize、完整 ANALYZE 三种状态结果一致。

## 同库统计维护实验

`scripts/performance/large-library-benchmark.ts` 增加 `JAVDEX_BENCH_STATS_PROBE=optimize|analyze`。先取得完整返回值和 EQP，再在同一夹具上维护统计并重放。单库 25 项；写入第二库及三分之一重叠成员后，重新取得该状态的期望值，再比较 27 项。不是拿写入前的旧结果判断写入后是否相等。

optimize 实验显式设置 `analysis_limit=1000` 并调用 `PRAGMA optimize=0x10012`，finally 恢复原 analysis_limit。它不是承诺固定毫秒上限的执行超时。analyze 模式执行完整 ANALYZE。二者都只在合成基准中运行，**尚未增加生产启动或后台统计钩子**。

最终 optimize 实验单库阶段用时 1.84 ms，写入重叠库后 0.14 ms；后一次调用不保证重新分析全部表。SQLite 根据统计状态自行决定是否分析。维护不是每次点击执行，也不能把一次快速调用解释为大库维护始终无阻塞。

最终完整 ANALYZE 两阶段分别为19.90/21.94 ms。两种模式都通过25/27项返回值全等断言，analysis_limit 都恢复为0；统计行数分别为44和51，不能把 optimize 等同于所有索引完整分析。

| 1 万影片，当前查询 | 缺统计（ms） | optimize 后（ms） |
|---|---:|---:|
| 手工标签 | 10.68 | 16.19 |
| 全部标签 | 6.98 | 8.90 |
| 单库列表 | 0.53 | 2.03 |
| Web 首屏 | 948.40 | 2.36 |
| Web 搜索 | 1,883.89 | 12.24 |
| Web 分类入口 | 870.35 | 3.35 |

统计更新并非单调改善。单库列表的 EQP 从利用成员排序索引并只对末排序项使用临时树，变成页子查询完整 ORDER BY 临时树；标签成员和关系的访问顺序也发生变化。小幅时差不单独认定为稳定回归，但可重复的计划变化需要在目标规模检查。

## 30 万规模仍存在的成本

300,382 影片、1,301,655 标签关系、完整 ANALYZE 的独立夹具测得：全部标签 573.68 ms，手工标签 **1,374.96 ms**，演员首屏 432.94 ms，单库列表 66.97 ms，多库列表 496.40 ms，多库首页 **708.23 ms**。这批查询修复不代表聚合已达到大库交互目标。

## 推荐后续实施

1. 为手工标签评估覆盖 origin 的关系索引，分别测试 manual 稀疏/密集、少量热门标签及大量零计数标签；同时核对写入放大与索引体积，通过正式 migration 落地，不能直接改客户库索引。
2. 分类选择器采用不附带计数的窄名称查询；需要计数的视图按数据库修订复用结果，避免重复聚合。缓存失效与隐藏、归档、来源修改同时验收。
3. 先消除 Web 无统计时的秒级计划退化，再接入有界后台统计维护。空闲调度只能决定开始时机，不能让同步 SQL 自动变成可中断工作；需结合 PERF-10 的独立连接生命周期、写锁和退出等待。
4. 统计维护前后继续覆盖全部筛选/排序、数据倾斜和大批量写入，记录 EQP、结果、时延与主循环阻塞。当前 25/27 项是基准脚本矩阵，不等于所有产品筛选组合。

## 证据与限制

- [修复前探针](large-library-results/implementation/batch-aa-statistics-before-query-fix.json)：第二阶段仅两项，是历史诊断证据，不能充当最终完整矩阵验收。
- [修复后 optimize](large-library-results/implementation/batch-aa-statistics-optimize.json)、[修复后 ANALYZE](large-library-results/implementation/batch-aa-statistics-analyze.json)、[30 万有统计结果](large-library-results/implementation/batch-aa-300382-analyzed.json)。
- SQLite 官方依据：[PRAGMA optimize](https://www.sqlite.org/pragma.html#pragma_optimize)。上述预算参数为本运行时的实验配置，不是通用默认值建议。

macOS M4 本地合成库；每项首次一次、热运行三次，中位数不是 p95，首次不代表冷磁盘。没有 Windows/HDD、真实客户分布、长时间并发或 8 小时稳定性证据。PERF-04 和整个实施计划仍未完成验收。
