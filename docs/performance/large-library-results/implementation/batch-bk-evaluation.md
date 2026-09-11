# 演员写真分页与显示顺序评估（BK）

2026-09-11，基线4c953a9，工作区累计优化。新增galleryPage后端/typedIPC/preload，实际资料和写真组件仍使用完整gallery；本报告不代表页面已经取得收益。

写真全局显示顺序是有效横图优先，然后position、id。来源过滤等同JavaScript String.trim后的local_path或remote_url任一非空；SQL显式列出ECMAScript空白字符，并用BLOB长度保留NUL。正宽高且计算比值有限并>1才归横图，其余归第二组；null position按0处理。两项过滤/排序都在LIMIT前执行，同一事务返回精确total与最多100项（默认60），limit1保持全局首项语义，供后续默认背景使用。

31项定向通过，其中新repo测试用9×9×11=891种来源/尺寸组合和null/负值/同值position，对照原prepareActressGalleryForDisplay，遍历返回完整字段与顺序一致。含纯Unicode空白、零宽字符、NUL、缺失/零/负尺寸、无限和溢出比值。另有空/缺失演员、非法参数、count后外部WAL移除来源的当前/下一次快照与IPC边界。该矩阵不代表任意损坏数据的全部SQLite动态类型组合。

| 数据库图片记录 / 可显示 | 旧metadata读取+JS准备 median / JSON字节 | 首60项 median / JSON字节 | 末60项 median / JSON字节 |
|---|---|---|---|
| 10,000 / 8,000 | 4.923ms / 3,253,425 | 4.873ms / 24,382 | 8.960ms / 24,469 |
| 50,000 / 40,000 | 26.028ms / 16,338,225 | 23.613ms / 24,383 | 47.441ms / 24,591 |

合成路径约270字节，横图/正方图混合，20%为空格无效来源；ANALYZE后一次预热、每项3个热样本，中位取中间值，固定旧方式先测。耗时排除断言和JSON序列化，完整oracle保留在内存。旧计时含metadata读取与原JS显示准备，其返回字节仅为准备后的gallery数组；新计时含存在性、count、SQL排序/页读取，字节为带total/limit/offset的完整页对象。

首末页完整字段对照原显示数组切片通过；旧完整显示数组每次也做完整字段比较。捕获页面EQP使用actress_id索引及临时排序，未独立测count/EQP。深页本夹具明显更慢，当前采用它是为限制IPC载荷和UI工作量，不是已经消除查询开销。应继续评估排序表达式索引/读模型与keyset、worker隔离；尚无跨平台或写放大数据支持新增生产索引。

本次没有p95、冷盘、Windows/HDD、真实IPC、媒体解码或峰值内存结论。原始路径字符串仍直接返回，行上限不等于字节上限。metadata/编辑器完整gallery、背景首项、图片预览跨页、导入删除后刷新与选择状态需要一起迁移，不能仅在组件中slice。完整15/42计划仍进行中。

复跑：`node scripts/run-electron-tests.mjs scripts/performance/actress-gallery-page-benchmark.ts`；日志、样本、EQP与源快照见[证据清单](large-library-results/implementation/batch-bk-manifest.json)。
