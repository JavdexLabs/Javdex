# BI 静态审查

Standards与Spec均未发现阻断。getActressMetadata抽出旧资料/name/alias/gallery/links读取，旧get复用后继续原作品SQL；withCover在count与ID页之前一致过滤BLOB非空，保留Boolean路径语义。类型、严格IPC校验及service/preload贯通。

metadata与当前legacy的等值比较共享实现，不单独证明独立等值；静态另对照旧代码。测试还明确核对资料字段/写真顺序，并禁止作品/资源SQL。metadata仍多次查询、含完整写真及长字段，不承诺事务快照或字节上限。UI仍未接入；完整15/42目标保持。

最终32定向通过，全量2303通过、1跳过、0失败（2304项），build成功。没有用户数据/媒体访问、schema修改、提交或推送。
