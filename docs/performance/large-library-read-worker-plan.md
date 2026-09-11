# 读查询隔离落地清单（历史批次与当前剩余项）

DF更新：高频桌面列表/年份/首页/全局搜索和Web列表/首页/分类集合已接入既有reader，详见[DF报告](large-library-high-frequency-cleanup-results.md)。下文保留历史批次及完整验收要求。

PERF-10整体仍未完成。AI提供独立只读连接和本机原生worker可行性；AJ已将TAG_FILTER_OPTIONS接入生产worker并验证本机ASAR。审计读取也已有专项worker入口，不能由此推断其余IPC/Web目录读取已隔离。当前schema18，先由writer完成迁移，再允许reader打开。下面六项保留完整验收要求，不能把单入口实现视为全部完成。

1. **查询归属**：先迁移标签筛选候选这一条已分页、有基准的入口。让仓储明确接收连接，保持现有全局active/可见/共享去重语义；worker不能调用依赖主线程全局writer的getDb。保留AH的有界缓存、外部data_version失效、原始参数验证及返回对象隔离，不以移入worker为由撤销已有保证。
2. **协议与队列**：只允许枚举的类型化只读命令，不开放任意SQL。单reader串行执行，设置待处理请求及合并请求的总上限；拥塞明确拒绝。相同参数的请求合并还必须考虑主线程写修订，防止写入后的刷新加入写入前旧请求。关闭/换库/重启使用代次隔离，旧响应不能落地。
3. **快照和取消**：每条查询独立短事务，处理完即结束，不跨消息等待保留快照。排队请求支持撤销；已运行同步SQLite不能假装已被普通JS信号取消，需要明确丢弃结果、超时终止及重建连接策略。WAL检查点、后台写入及长读持有时间都需测量。
4. **生命周期**：ready之前不接受执行，schema/WAL检查失败返回明确错误。worker异常/无结果退出使在途和排队请求settle；重试必须有上限。退出先停止准入，再排空或终止reader，最后关闭writer；异常停机和重复dispose都应可验收。禁止静默回退到主线程慢SQL来掩盖隔离失效。
5. **构建与测试**：正式worker入口纳入electron-vite开发/构建，验证asar内模块与native addon定位。AI临时bundle中的createRequire只属于探针，不能当作打包证明。真实worker测试覆盖native加载、写后读、相同计数换库、队列上限、请求合并修订、晚到响应、崩溃/重启、退出与资源释放。
6. **推广与验收**：记录实际IPC端到端首读/命中/失效、主循环间隔、峰值内存、WAL大小与写入影响。再按完整计划推广到列表/计数/首页/Web等读路径。保留Windows/HDD、冷盘、p95、长跑与故障矩阵；不以一次合成CPU探针宣布全局隔离完成。

证据：[AI实施记录](large-library-implementation-status.md)、[原生worker结果](large-library-results/implementation/batch-ai-worker-probe.json)。


AJ已落实第1项的标签入口、第2项有界合并与代次、短读事务、基本生命周期及构建。仍需补齐：原生长查询中的退出/故障验证，旧worker原生终止本身的期限，renderer到IPC取消，WAL/写入竞争、真实IPC端到端与目标平台。普通JS取消或Worker.terminate均不能被描述为SQLite硬中断；确认旧reader结束前不得另开替代worker或关闭writer。终止明确拒绝会非零退出，终止一直pending的上界尚未解决。详见[AJ实施记录与限制](large-library-implementation-status.md)。

AK已补逐订阅30秒排队期限，涵盖初始化、执行槽等待和替换屏障等待。执行前清除等待计时器，执行仍受单独15秒deadline约束；超时释放订阅容量且不自动重试，也不绕过旧reader终止屏障。30秒不是总请求期限，更不是SQLite原生终止保证。原生终止永久pending时，排队调用者现在会收到超时错误，dispose仍待底层实际结束。


AP补充依赖：演员冲突的list/summary入口均调用`actressIdentityConflictWorkflow.ts`的`ensureCurrentPendingConflicts`。该函数全量读取待刮削result_json，逐条重新核对名称冲突，并可能INSERT缺失冲突、递增pending revision。因而当前summary不能直接放入只读worker，也不能声称不读取JSON。推广前须将必要的一致性维护与只读投影分开，证明名称归属变化、历史缺项和事务回滚情况下结果等价；不得通过删掉维护调用掩盖工作量。AP的UI按需读取只减少无关分类的完整详情/字段计划请求，不关闭该风险。


AQ降低未变化轮询的维护成本：ensureCurrentPendingConflicts在同一连接、total_changes/data_version/schema_version均相同且上一遍无写入时复用检查完成标记。任何修复写入会要求后续调用继续检查，以保留后访问候选引出先访问候选冲突的多遍语义。调用方事务内不复用、不发布，失败/换库/外部提交失效。这不是纯读拆分：冷读/任意写入后仍可全量修复并写入，summary分组聚合仍遍历冲突记录；推广只读worker的AP前置条件继续有效。


AR新增演员概要页和单组get接口。概要先走必要维护，再在短事务中聚合只含名称、归组、状态和头像的元数据；当前依赖getDb与中文localeCompare，尚未迁移worker。单组get限制候选JSON/资源到记录过目标名字的候选，保留其所有冲突以计算剩余决定；冷维护仍触及全队列，单组mergePairs仍未有界化。下一步renderer迁移不得把概要当作提交依据，必须先获取完整组及修订快照；不得把查询超时/暂缺等同于组已删除而清空未提交选择。


2026-09-11 收尾决定：用户要求完成 NFO 优化及文档后停止，本计划其余推广与目标平台验证暂不执行。上文 AI–AR 是历史批次记录；当前扫描审计使用schema18的manifest/entries，reader须与writer迁移完成后的实际schema一致。新增扫描/NFO TEMP工作集由本次扫描连接拥有，不作为独立reader的共享业务表。全局推广、原生终止/WAL及目标平台验收仍未完成；统一范围见[完整待办矩阵](large-library-optimization-plan.md#12-收尾范围与完整待办矩阵)。
