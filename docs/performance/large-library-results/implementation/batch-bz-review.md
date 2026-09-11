# BZ只读复核与提取证据

Reviewer `01a0895e-3dbd-78e3-abef-f3ab66f8ffd6` 未发现新增阻断；未改文件或运行测试。

- 新IPC通往worker，renderer无法指定预算，strictschema/固定策略一致，无同步fallback。
- header同一读事务，保留坏summary/null规则及前后字节检查。
- snapshot只表示audit非NULL，正文有效性在后续page验证；header/page不是跨请求原子事务。
- shared helper由实际面板调用，无读取或生命周期副作用；尚未替换UI全量快照。

实现helper `01a0895d-ca2c-7fd3-ac9d-20557ea20724` 提取五函数+ViewItem，旧函数同25测试及新shared/UI36通过。主任务另以TypeScript AST验证五body逐字一致（JSON已归档）。原oracle preload保留其当时/tmp引用，复跑时需将同目录归档oracle复制到/tmp/scan-audit-view-oracle.cjs或调整该路径；它仅替换测试的./scanAuditView模块。

全量类型检查曾指出旧tag测试query.offset不适用于新增header union，补TagOptionsQuery类型窄化，保留offset=200原断言；未放宽门禁。新增header WAL原子性测试在父任务80项定向中通过。
