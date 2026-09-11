# CX 默认扫描切换至 entries 审计

默认createScanCoordinator使用entries；显式auditStorage=json保留旧JSON测试/兼容路径。beginRun与writer.start同事务；scanner使用同步sink；cleanup直写且不填充原审计数组；终结将pending refresh、seal与finishEntries置于同一事务。未识别文件从封存entries逐条映射，保留root匹配/授权/归一化。成功审计audit_json为NULL、manifest published。

失败策略明确：文件/NFO/cleanup写失败且事务已回滚时，尝试一次failed publication；持续失败则尽力标记未发布run失败，保留staging交启动恢复。正常终结refresh/seal/publish失败不重试终结。二次失败不覆盖原错误，已发布run不降级。取消保留已提交条目且不替换旧未识别记录。

scanner sink模式新增ScanFoldersFailure，停止后转移当前ScanResult并保留cause，不复制大数组；coordinator校验scope后采用partial counts。pendingGroups在错误出口补齐，不额外增加failed。Legacy错误身份行为保留，sink错误测试改验证cause。

正式接入发现total_changes使审计单独写入污染STRM缓存修订。真实20文件混合扫描红测10次重建；sink契约限定不改video_resources，使用已知无资源写入跟踪。嵌套无资源跟踪由外层资源写入负责，其他嵌套资源写入仍保守失效，异常finally恢复depth。最终同测试仅1次重建；不据此推断所有混合负载或总吞吐。

新增17测试：12默认协调器真实scanner/DB集成覆盖新旧结果与完整audit差分、真实NFO/pending/cleanup/header/未识别记录、开始故障、各阶段native故障、严格一次终结、取消、partial counts及持久故障恢复；2scanner计数/混合重建回归，3缓存嵌套/失效回归。旧fake协调器和手动writer夹具显式json，其他真实路径清理测试继续默认entries。

246联合通过；最终npm test退出0，2673通过/1跳过/0失败（2674项）；npm run build退出0。静态复核无剩余本批阻断，schema18不变，旧冲突controller测试仍+27/-0。

剩余内存与时延风险仍在：scanner discovery/preflight/NFO containers及ScanResult.newCodes/unrecognizedFiles等数组，resource-less membership返回全集、同步FS/清理事务和逐项写成本；未完成300k/600k生产格式吞吐/RSS、Windows/HDD/长期/并发/真实进程中断矩阵。初始primary中断恢复仍待验证。完整15/42不完成。无用户库访问、提交、推送、发布。patch是选定相对HEAD累积差异及完整新增文件，依赖前序批次。
