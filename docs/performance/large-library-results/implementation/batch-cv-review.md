# CV 待确认分组审计派生与原子重建

新增visitPendingScanAuditEntriesForRun，同连接事务内验证run/library/collecting，SQL根据最终files outcomes派生group IDs及GLOBAL exact pendingPaths。路径匹配使用entry_key的BINARY查找，包含无groupId的pending路径，保留重复resource计数、零计数组及updated_at/id顺序；不向JS读取全files/路径Set/分组Set。

实际红测证实iterate活动查询内writer嵌套savepoint报connection busy（原refresh5项失败）。最终采用SQL TEMP窄快照和逐条已完成get后回调；TEMP成功DROP，异常由同事务回滚清除；snapshot使callback后修改pending业务表也不改变本次结果。没有unsafeMode。

writer.refreshPendingGroups在外层事务删除旧pendingGroups并重建，缓冲最多100项且编码数组不超1MiB，末批flush也在外层事务；超大单项经正常writer校验拒绝。创建时scope身份独立捕获，不受调用方之后修改scope影响。ordinal为每次按当前排序从0连续重建，不承诺跨排序变化的group身份不变。

新增17测试：9repo visitor差分/隔离/生命周期/同步callback/外层回滚/TEMP清理/SQL投影与索引/大项拒绝；8writer重复刷新/当前元数据/第二条原生INSERT故障/外层业务回滚/预算/状态/207分组分批/字节flush/scope变更。85联合测试通过，静态复核无剩余阻断。

输入的单个normalizedCode在writer拒绝前仍可能很大；TEMP窄结果占O(分组数) SQLite空间，SQL还会扫描本run files。没有全内存固定、吞吐、RSS或平台验收声明。正式coordinator仍旧路径，后续需把本方法接到终结/封存事务并处理unrecognized、全量结果及cleanup数组，完整15/42不完成。

最终npm test退出0：2641通过/1跳过/0失败（2642项）；npm run build退出0。schema18与原冲突controller测试+27/-0未改变。未访问用户数据、提交、推送或发布。patch为相对HEAD选择范围的累积差异/完整新增文件，依赖前序批次。
