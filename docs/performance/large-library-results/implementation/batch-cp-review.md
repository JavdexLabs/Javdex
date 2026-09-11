# CP 复核与验证

三段同步STRM业务+审计事务：已有目标更新/unchanged、重定位、invalid待确认删除。sink同连接写入为原子性前提；索引mutate封装整个事务，计数提交后更新，await/进度在事务外。无sink旧路径不加外层事务。

新增三组真实scanner测试在native审计INSERT失败前观察已修改的业务字段或已删除pending，独立连接看旧数据；故障后资源/影片或pendingresource/group与审计整体恢复，移除故障后重试成功。另覆盖unchanged、ordinal、失败计数/进度。不是只证明空操作回滚。重试为新scan调用，不独立声称本测试验证旧索引缓存的复用；既有索引异常单元和当前调用边界另有支持。

159定向通过；npm test完整退出0：2582通过/1跳过/0失败；npm run build完整退出0。静态复核无本批阻断。旧冲突controller测试仍+27/-0。未访问用户库、提交、推送、发布；无新性能探针，不宣称吞吐/RSS收益。

补丁为选定文件相对HEAD累积差异及完整新测试，依赖前面批次。其他业务写入/NFO/cleanup尚未共同提交，coordinator尚未切换，完整15/42不完成。
