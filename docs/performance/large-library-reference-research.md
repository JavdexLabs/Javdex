# 大媒体库优化：官方资料核对（Issue #100）

核对日期：2026-09-10；工作区基线：`dev / 4c953a9`。场景由任务提供：300,382 部影片、约 1 GB 数据库、Windows HDD；这些数字不是本次测量结果。

本文负责外部依据和方案边界，代码行号、真实调用链、现有缓解措施及基准由主审计提供。没有读取用户数据库、运行性能测试或修改生产代码。下文“建议”“验收”均为待验证的工程方案，不能当作已定位的仓库缺陷或已取得的收益。

## 1. 查询计划、DISTINCT 与有界工作量

官方事实：EQP 的 `SCAN` 可包含按索引顺序全扫描，`SEARCH` 表示访问子集；覆盖索引避免额外取表字段。排序、分组、去重可能使用临时 B-tree，也可能由索引满足。EQP 是调试接口，输出格式会随版本变化；它不是耗时测量。[SQLite EQP](https://sqlite.org/eqp.html)

`DISTINCT` 按完整结果行去重，NULL 去重比较、数值和文本排序规则也影响结果。因此不能只凭出现该关键字就删掉它。[SQLite DISTINCT 语义](https://sqlite.org/lang_select.html#distinct)

建议主审计对每条热点分别记录：UI 触发 → IPC/HTTP → service/repo → SQL → 后处理 → 返回/渲染，并标记以下不同边界：

| 边界 | 要证明什么 | 不能据此推导什么 |
| --- | --- | --- |
| 返回分页 | 单次返回条数/字节受上限约束 | SQL 只扫描一页 |
| DOM 虚拟化 | 挂载节点随视口受限 | JS 缓存、关联查询和解码图片内存受限 |
| 请求去重/缓存 | 相同请求的重复执行减少 | 缓存未命中时工作量下降 |
| SQL 索引 | 实际约束、排序与索引匹配 | 任意筛选组合都足够快 |

建议：若 JOIN 仅用于“是否有关联”，比较 `EXISTS` 与 JOIN 后去重；若结果天然唯一，先证明关系基数再移除 `DISTINCT`。可尝试先查本页 ID 再批量补字段，但筛选、排序和去重必须在分页前保持等价。验收包含重复关联、空关联、多条件交集、排序并列及跨页遗漏；同时检查主查询、count、补充查询，不能只测最快的一段。

深 OFFSET 会计算并丢弃前面的结果。官方给出行值比较的游标分页替代方案，但高效执行需要合适索引。[SQLite scrolling window queries](https://sqlite.org/rowvalue.html#scrolling_window_queries)

建议：对顺序翻页评估“排序字段 + 唯一 ID”游标；明确 NULL、升降序混合、筛选变更和数据更新时的行为。跳页、返回定位需独立设计。精确总数仍应单独测量，不能因列表改成游标就宣称所有查询有界。

## 2. 子串搜索与 FTS5：先保语义，再建索引

普通 B-tree 的 LIKE 范围优化要求模式不以通配符开头，并满足类型、collation 等条件；给文本列加普通索引不能保证加速 `%term%`。[SQLite LIKE optimization](https://sqlite.org/optoverview.html#the_like_optimization)

官方边界简表（均来自同一 FTS5 文档，压缩转述）：

| 项目 | 已核对约束 |
| --- | --- |
| trigram | 支持子串；不足 3 个 Unicode 字符的 MATCH 不命中 |
| LIKE/GLOB | 缺可用三字符片段会扫描；LIKE 带 ESCAPE 不用该索引 |
| 配置 | `case_sensitive=1` 仅支持 GLOB 索引；去音调影响 LIKE/GLOB 支持 |
| MATCH | 有查询语言；`detail=none/column` 不允许超过三字符的查询 token |
| 普通 contentless | 字段返回 NULL；不支持普通 UPDATE/DELETE，删除需专用命令和原文 |
| contentless-delete | SQLite ≥3.43；支持 DELETE/REPLACE，UPDATE 需提供全部用户列 |
| external content | 应用负责同步；新增触发器不会补建历史数据 |

来源：[FTS5 trigram](https://sqlite.org/fts5.html#the_trigram_tokenizer)、[MATCH 语法](https://sqlite.org/fts5.html#full_text_query_syntax)、[contentless 与 external content](https://sqlite.org/fts5.html#external_content_and_contentless_tables)。

建议先评估 external-content trigram，保留现有搜索路径作为回退；暂不直接批准“contentless + LIKE”组合。短词回退仍应标成随候选规模增长；若改成前缀或精确搜索，应作为产品语义变更评审，不能悄悄漏掉一、二字中文结果。

搜索验收语料建议包含：一/二/三字中文、日文、混合大小写编号、连字符、引号、空格、`AND/OR/NOT`、`%/_`、重音与组合字符。逐项比较旧路径与候选路径的 ID 集合、排序、总数和分页；SQL 参数绑定之外，还须验证 MATCH 的字面量编码。增加“只更新一列、批量删、回滚、导入覆盖、重启”的一致性检查。该验收设计不预设候选方案一定保持原语义。

## 3. PRAGMA：逐项实验，保留实际回读值

| 设置 | 官方事实 | 本场景建议 |
| --- | --- | --- |
| `cache_size` | 正数为页数，负数按 KiB 换算；是建议上限、按需分配，连接重开不保留 | 试验当前值、32/64 MiB 等小矩阵；按所有连接计总预算 |
| `mmap_size` | 单库映射字节上限，受编译/启动上限限制 | 回读是否生效；不要等同于预读或锁定整库内存 |
| `temp_store` | MEMORY 控制临时表/索引，编译配置可覆盖；运行中修改会删除已有临时对象 | 仅在连接初始化实验，先减少排序输入 |

事实来源：[cache_size](https://sqlite.org/pragma.html#pragma_cache_size)、[mmap_size](https://sqlite.org/pragma.html#pragma_mmap_size)、[temp_store](https://sqlite.org/pragma.html#pragma_temp_store)。这些设置不是进程总内存限制；上述试验档位为建议值，不是官方推荐或发布默认值。

mmap 可减少拷贝，但官方明确指出可能变慢；映射 I/O 错误可能导致进程崩溃。Windows 映射文件的截断存在限制，VACUUM 缩容可能不生效。[SQLite memory-mapped I/O](https://sqlite.org/mmap.html)

建议：Windows HDD 上分别测冷读、热读、写入并发、内存压力和缩容流程，记录工作集、缺页、I/O 与尾延迟。只有收益稳定且恢复路径经过验证，才考虑修改默认值。

`temp_store=MEMORY` 不会把 WAL/事务日志一并移入内存；即使使用文件临时存储，小临时对象也可能仅停留在页缓存。因此 EQP 出现临时 B-tree 不等于已经产生磁盘临时文件。[SQLite temporary files](https://sqlite.org/tempfiles.html#the_sqlite_temp_store_compile_time_parameter_and_pragma)

`busy_timeout` 是锁竞争时的等待策略；累计等待后仍可能返回 `SQLITE_BUSY`，每连接仅有一个 busy handler。[SQLite busy timeout](https://sqlite.org/c3ref/busy_timeout.html)

建议：不要把加大 timeout 写成查询优化或 SQL 执行超时。若调用本身同步，等待也需纳入主线程阻塞预算；后台任务优先采用短事务、有限重试及可取消队列。

`ANALYZE` 为优化器收集统计。SQLite 3.46 起推荐 `PRAGMA optimize`，会限制分析工作；长期连接可初始化执行 `optimize=0x10002`，之后周期执行，并在建索引后执行。[SQLite ANALYZE recommended usage](https://sqlite.org/lang_analyze.html#recommended_usage_patterns)

建议：先由主代理确认打包 SQLite 版本及编译能力，再选择维护策略；统计更新前后保存计划和耗时。它属于可能写入统计的维护，不是只读检查，也不等同于 FTS 索引构建。不要把维护排在每次列表请求或首屏必经路径上。

## 4. WAL、耐久性与后台迁移

WAL 允许读写并行，但同时仍只有一个写者；长读事务会阻碍 checkpoint。默认自动 checkpoint 阈值为 1,000 页，可由编译或运行配置改变；checkpoint 本身也有 I/O 成本。[SQLite WAL concurrency and checkpointing](https://sqlite.org/wal.html#concurrency)

WAL + `synchronous=NORMAL` 保持一致性，但断电/系统崩溃可能丢失已提交事务；FULL 每次提交增加同步以提供耐久性。OFF 还可能在断电时损坏库。[SQLite synchronous](https://sqlite.org/pragma.html#pragma_synchronous)

建议保留耐久性决策的独立性：不能仅为搜索更快降低同步级别。收藏、评分等人工数据与可重建索引不能不加区分地讨论。多开 worker 也不能消除写锁与 HDD 争用。

迁移方案建议（设计草案，未实现）：

1. 在测试生成库上检测实际 FTS 能力、稳定 rowid 映射、索引大小与构建空间；给主库、WAL、临时文件共同留预算。
2. 建立 `building/ready/failed` 状态和可恢复进度；未 ready 时保持旧查询路径。避免首次启动单个大事务补全 300,382 行。
3. 由专用数据库 worker 使用自己的连接按稳定主键分批，行数和耗时双重限制；每批事务内读取当前源值、写入目标并提交进度，批间让出写入机会。
4. 在线构建必须选定一种一致性协议：串行协调所有写入，或事务性变更日志加重放。不能把“装上触发器再分批 INSERT”视为充分方案；需处理尚未回填行的更新删除、重复写入、旧值覆盖新值和删除后复活。
5. 追平增量并验证后，在短事务/协调屏障内切换 ready。失败可清理未发布索引并重建，重启可恢复；同时设计磁盘满、取消、旧版本打开及发布回退。

建议验收：构建期间持续浏览和编辑；在批次各阶段强制终止并恢复；比对搜索 ID 集合与更新删除结果；记录最长写锁占用、WAL 峰值和回收情况。后台化改善响应性与总构建耗时分别报告。

## 5. Electron 与 TanStack Query

Electron 官方要求避免主进程长时间阻塞，包括同步 I/O、同步 IPC；CPU 密集工作可移交 worker。[Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance#3-blocking-the-main-process)

建议主审计确认同步数据库、文件检查及大结果转换的实际执行线程。函数声明为 async、IPC 返回 Promise 或使用 setTimeout，都不是工作已离开主线程的证据。worker 返回仍应分页/分批，避免把整库对象复制给主进程；队列上限、请求合并、取消和过期结果丢弃需一起设计。验收同时记录端到端延迟和主进程事件循环延迟。

TanStack Query 默认会在重新聚焦且数据 stale 时后台刷新；可全局或逐 query 关闭。当前文档默认事件实现使用 `visibilitychange`，并非任意原生窗口 focus 都保证触发。[TanStack window focus refetching](https://tanstack.com/query/latest/docs/framework/react/guides/window-focus-refetching)

建议先核对锁文件版本、全局选项、query 覆盖和自定义 focusManager，再断言仓库有重复刷新。若已有关闭策略，归为现有缓解。优先给昂贵查询配置合理新鲜期和精确失效；全局关闭会要求补齐外部导入、多窗口编辑及手动刷新的更新机制。验收记录切窗前后的 SQL/IPC 次数，且确认编辑后数据能在约定时限内更新。

## 6. HTTP 图片缓存：immutable 必须配合资源身份

`immutable` 表示资源在 freshness 生命周期内不变，客户端通常可跳过条件验证；过期后仍按普通规则验证，它本身不定义缓存时长。[RFC 8246 §2](https://www.rfc-editor.org/rfc/rfc8246.html#section-2)

建议：只有内容改变就换 URL 的图片资源才使用长期 `max-age` + `immutable`。仅含影片 ID、但内容可被重新刮削覆盖的地址，不满足该设计前提。可选内容 hash 或可靠版本号，必须覆盖替换、裁剪及缩略图算法变化；不要每次请求重新计算全文件 hash。

对保持同 URL 的可变图片，可评估 ETag/Last-Modified 条件请求；`no-cache` 允许存储但复用前要验证，`no-store` 禁止存储，`private` 限制共享缓存存储。[RFC 9111 validation](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.3)、[cache directives](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2)

建议验收浏览器实际行为：初次 200、缓存命中/304、换图后新内容、刷新及重启、错误后恢复。分别记录请求数、响应体字节、文件 stat/read 次数和解码成本；304 不代表服务端零 I/O。桌面自定义协议能否获得同等缓存行为，应另行实测，不能仅凭 HTTP 规范推断。

## 7. 建议优先级与交付门槛

以下是实施顺序建议；具体缺陷优先级必须结合主审计的调用频率、代码证据和测量调整。

| 优先级 | 候选工作 | 进入实施条件 | 验收门槛 |
| --- | --- | --- | --- |
| P0 | 明确阻塞/无界路径，补测量口径 | 有真实调用链与行号 | 区分返回、扫描、内存、DOM 边界；既有分页/缓存/虚拟化明确记账 |
| P1 | 减少重复查询、JOIN 放大和冗余补字段 | 证明热点及语义等价 | 同结果集；端到端 p95 改善；写入无明显回归 |
| P1 | 主进程重活后台化、有限队列 | 证实长任务在主线程 | 构建/查询期间交互可用；队列和传输量有上限；可取消恢复 |
| P2 | 搜索索引及深页游标 | 现有搜索/深页实测不足 | 短词、特殊字符、分页一致；迁移中断与并发编辑通过 |
| P2 | 图片版本化、精准缓存失效 | 证实重复 I/O 且身份规则明确 | 命中减少请求/I/O；替换后不会长期显示旧图 |
| P3 | mmap/cache/temp/optimize 调整 | 查询形态已优化，版本能力确认 | 冷热读和压力场景都报告；尾延迟、内存、耐久性与恢复无未解释退化 |

主代理测量建议：使用生成数据覆盖 1 万、10 万、300,382 行，并模拟关系扇出、长文本、空值及冷热图片；不能只填充文件到 1 GB。固定页大小、筛选和硬件，分离首次启动、首次查询、重复查询、深页及构建并发，记录 p50/p95/max、RSS、主线程延迟和磁盘 I/O。重启进程不等于操作系统冷缓存。绝对时延目标由主审计结合实际 Windows HDD 基线填写；本文不虚构毫秒值或加速倍数。
