# CQ 复核与验证

四段本地post-duration业务与审计同事务：relocation、mustConfirm、新资源加入已有影片、新影片+资源+membership。计数/集合/NFO队列在提交后更新。sink模式缺新资源时抛错回滚；旧无sink不加外层事务。探测/progress无新增跨事务await。

四组真实scanner native INSERT故障前观察实际新增/修改业务行，独立reader仍看旧值；故障后五表完整快照与空audit恢复，重试验证分支计数/审计业务ID/ordinal/无关数据。旧recordFile和asyncrecord错误测试加强为0videos。

失败不返回ScanResult，测试不能直接读取失败计数；队列更新位置另由代码结构支撑，nfoApplies=0不独立证明内存队列从未加入。重试是新scan实例。未进行新时延/RSS/平台基准，未声称整体扫描原子性或性能完成。

163定向通过；npm test完整退出0：2586通过/1跳过/0失败；npm run build完整退出0；静态复核无本批阻断。旧冲突controller测试仍+27/-0。schema18不变。未访问用户库、提交、推送或发布。

patch是选定文件相对HEAD累积diff及完整新增测试，依赖前面批次，不是独立顺序补丁。其他业务刷新/NFO/cleanup/coordinator仍待完成，完整15/42保持进行。
