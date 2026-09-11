# CW 未识别文件逐项发布接口

finishLibraryScanEntriesRun单独接受同步Iterable输入；旧JSON finish的readonly array签名保留。消费仍在原完成事务内，失败/取消/没有替换roots时不枚举；root集合过滤和原严格INSERT规则不变，不预先展开迭代器。

新增iterateScanAuditUnrecognizedPaths读取封存files的最终unrecognized outcomes，按ordinal keyset跨越间隙，投影仅ordinal/entry_key，每次get完成后yield；无活动iterator、files全集或all数组。捕获创建时scope，每次恢复检查活动事务、归属、sealed和running/completed状态，来源消失或状态变化失败，不冒充EOF。helper不负责目录匹配、授权或归一化，未来coordinator必须保留原规则。

迭代器一次性，每次发布重试必须重新创建；不支持跨事务暂停或异步消费。inTransaction只能确认当前存在事务，不能证明还是原事务。单个路径大小与总同步遍历/写锁时间没有新上限声明。

新增15测试：8发布接口覆盖array/generator等值、范围隔离、中途native INSERT及晚publish故障回滚、迭代器关闭/新实例重试、失败/取消/无roots不消费、async-only对象拒绝；7helper测试覆盖最终upsert、顺序/间隙、窄投影、scope变更、逐次状态、真实finish同连接及第二项映射/原生写入失败。映射/授权异常为测试注入，不等同生产文件系统权限矩阵验证。

98联合通过。初次全量类型检查发现测试spy展开重载get的TS2556，已用Reflect.apply修正，仅改测试。静态复核无本批阻断。正式coordinator仍构造旧unrecognized数组；接入、封存+发布原子边界、取消/失败恢复及剩余全量容器继续后续。完整15/42未完成，无新性能/RSS/Windows结论。

最终npm test退出0：2656通过/1跳过/0失败（2657项）；npm run build退出0。schema18、旧冲突controller测试+27/-0保持。无用户库访问、提交、推送或发布。选定patch是相对HEAD累积差异及完整新增文件，依赖前序批次。
