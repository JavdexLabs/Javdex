# CS 复核与验收

剩余3STRM导入/入队分支和registered local probe/backfill与审计同连接同步事务，计数/集合/队列提交后更新。local helper仅准备同步更新闭包，caller在await后授权再提交；invalidprobe保留原授权检查，无新增跨probe事务。

6项新增测试覆盖3STRM native fault、2localprobe/backfill fault/重试/unchanged/invalidprobe以及probe期间禁用root。业务先改变再审计INSERT故障，独立reader旧值与完整回滚/重试关联均有证据。mtime使用正式statFileFingerprint取整值；gate测试已修race和finally等待扫描终结的清理问题。复核无剩余本批阻断。

175定向通过；npm test完整退出0：2598通过/1跳过/0失败；npm run build完整退出0。schema18不变，旧冲突controller测试仍+27/-0。无新性能/RSS/平台测量，无用户库访问、提交、推送、发布。

静态核对主文件循环未见剩余未接入的业务写入，不包含收尾NFO/primary/cleanup及coordinator。正式coordinator未切换sink，完整15/42不完成。patch为相对HEAD选定累积源码与完整新增测试，依赖此前批次。
