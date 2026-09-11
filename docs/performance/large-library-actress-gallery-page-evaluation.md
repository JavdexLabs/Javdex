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


## BL：不携带图库全集的资料头

新增profile接口在同一读事务内返回原资料字段、gallery_count（全部写真记录）、display_gallery_count（有效显示来源）和first_gallery（全局首图或null）。姓名、别名和链接仍完整保留；原metadata/get接口合同不变。背景helper同时接受旧gallery数组或新first_gallery，显式poster优先、关闭fallback规则一致。当前UI尚未接入profile，不能据此称照片首屏载荷已经下降。

10,001条写真测试截获SQL，禁止作品读取，所有写真SELECT *必须带LIMIT且实际最多一行；资料字段/count/首图和背景与旧结果对照。metadata与profile共享核心字段helper，不以该对照独自证明核心字段转换，静态另核对提取前代码。外部WAL在核心资料读后新增横图，当前数量/首图保持旧快照，下次才看到新增。照片总数的两个口径避免后续合并弹窗把有效照片数当作物理记录数。

| 写真记录数 | 旧完整metadata median / JSON字节 | 新完整profile median / JSON字节 |
|---|---|---|
| 10,000 | 4.462ms / 3,525,474 | 4.883ms / 923 |
| 50,000 | 25.741ms / 17,705,474 | 23.987ms / 924 |

这是同一探针新增的两项完整返回对象测量，区别于BK的“准备后gallery数组”。同样为ANALYZE/一次预热/3热样本、固定顺序、校验和序列化不计时，完整oracle仍驻留。旧metadata逐次完整字段等值，新profile逐次对照原资料字段及预期双计数/首图；本轮完整原始样本见BL证据。两组查询时间接近，只能确认本夹具返回量大幅减少，不能声称初始化已恒定时间或稳定提速。first_gallery内路径、姓名/别名/链接/简介仍无硬字节上限；924字节是夹具实测，不是API最大值。

39项定向通过，全量2,317通过、1跳过、0失败，build成功。与BK相同的UI、预览跨页、后台化和深页要求继续保留。[BL证据清单](large-library-results/implementation/batch-bl-manifest.json)。

## BN：实际页面与预览接入

主演员页已切换到`profile`，主写真网格使用`galleryPage`，不再在renderer排序/渲染整个图库。网格与独立预览窗口各保留最多60项；本地网格使用640缩略图，预览条使用320缩略图，主预览仍取原图。实际浏览器合成125张写真验证60/60/5、双向跨页、失败重试与慢请求保留当前图；详见[实施记录BN](large-library-implementation-status.md)。

为了在导入、删除、排序变化后的刷新中保持照片身份，分页接口增加按`anchorId`定位所在页的可选查询。同一事务内通过`ROW_NUMBER`按既有显示过滤及排序计算位置，再读取对应页。它限制返回的数据量，却仍遍历/排序演员图库；没有新增索引、worker或本批计时样本，不应把此前热样本套用为anchor耗时，更不能宣称查询恒定时间。跨页读取仍是实时视图，不提供跨多个请求的数据库快照保证。
