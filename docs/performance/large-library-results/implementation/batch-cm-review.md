# CM 复核记录

双格式选源与raw/view/permission/compat读取接线。初次复核发现新index只检查version/identity，遗漏必需metadata校验且布尔version被SQLite当整数，已修复为保留JSON类型的scalar读取、重复root键/嵌入集合拒绝、normalizeAudit元字段校验及run身份核对。扩展缺字段、非法枚举、布尔version用例后复核无本批阻断。

来源body改iterate消除额外全量raw行数组，但兼容结果本身仍全量。新metadata结构校验不等于未来writer所有业务与页预算校验；生产仍写旧JSON。本批未开展新性能探针或新格式跨进程大库/退出矩阵；实际新reader差分与现有worker/IPC回归通过，不能夸大其范围。

84定向通过；npm test退出0，2540通过/1跳过/0失败；npm run build退出0。旧冲突controller测试仍+27/-0。schema18不再变更；无用户库访问、提交、推送或发布。

补丁是选定文件相对HEAD的累积源码，包含此前未提交新增文件内容，依赖CL及早期批次，不是独立顺序补丁。
