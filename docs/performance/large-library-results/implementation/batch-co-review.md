# CO 复核与验收

实际scanner可选同步sink；sink模式及无消费者模式不保留audit Map。原finalcallback仍保留旧行为。record/读取/修订失败fatal，NFO保留既有warning合并。writer仅返回有界NFO投影，缺省/null一致，scope和事务内字节预检保留。

复核关闭两项：void callback可接受async实现导致未完成却继续的问题，三个方法统一thenable拒绝并观察rejection；duration gate测试异常分支可能未等扫描结束就清理，通过race+finally等待修正。同步契约拒绝不能撤销调用方错误async实现已启动的副作用。

147定向通过；gate修正后14sink测试及单文件ESLint重新通过；完整npm test退出0：2579通过/1跳过/0失败；npm run build退出0。full runtime测试启动前gate测试修正已落盘。旧冲突controller测试仍+27/-0。

真实fresh库oracle比较结果和audit，独立readonly连接在后续probe等待时看到已提交条目；没有新性能/RSS/平台测量。正式coordinator尚未传sink，scanner业务→审计提交窗口仍待处理，不能视为生产流式任务已经验收。

patch为选定累积源码，依赖此前批次，非独立顺序补丁。无用户库访问、提交、推送、发布。
