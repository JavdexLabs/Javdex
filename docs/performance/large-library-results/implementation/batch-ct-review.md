# CT 复核与验收

NFO apply新增可选同步beforeCommit回调，普通应用与待确认候选写入在同连接事务内更新扫描审计。图片暂存保持事务外，失败由已有资产ledger补偿；不增加自定义逐路径SQL清理。旧afterSuccessfulApply合同保留。

scanner修订所有anchor时不yield，回调异常致命传播，避免被通用NFO catch降级。提交后结果不变则跳过重复SQL更新；新增头像/清理警告仍最终补写。头像查找和旧候选清理的提交后异常保持已提交disposition。

新增14项测试：10服务测试覆盖实际业务/候选回滚、真实暂存文件保留/清理、异步回调拒绝及提交后警告；4scanner测试覆盖两个anchor第二条native UPDATE失败全回滚、无变化2次/新增警告4次实际更新、真实NFO解析与业务路径。重试证据是NFO事务/服务重试，不等同整扫描断点恢复。

273项联合测试通过。全量首次检查发现测试fixture对含私有字段class不完整强转，已改为真实adapter实例覆盖两方法；无新增生产逻辑，静态复核通过。

核心disposition和事务内警告原子提交；提交后图片诊断仍有最终补写窗口。全量anchor容器、同步长事务、primary/cleanup/coordinator及平台矩阵仍未完成，不能据此宣称PERF-08或完整15/42完成。

最终npm test退出0：2612通过、1跳过、0失败（2613项）；npm run build退出0。schema18不变，旧冲突controller测试仍+27/-0。未进行用户库访问、提交、推送或发布。选定patch是相对HEAD的累积源码差异及完整新增测试，依赖前序批次。
