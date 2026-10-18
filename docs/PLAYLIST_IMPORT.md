# 外部清单导入合同

外部清单导入是桌面发起的前台 Agent 用例。用户先冻结来源 URL、活动目标媒体库、新建或追加目标及链接选项；全部条目处理完毕后才正式写入。操作说明见[清单指南](../website/src/content/docs/guide/playlists.md#从网页导入外部清单)，身份决策见 [ADR-0025](adr/0025-import-external-playlists-with-global-catalog-reuse.md)。

## 目标与资料归属

清单属于全局目录，可以引用不同媒体库甚至已无媒体库成员的影片。目标媒体库只承接新建影片，并在多候选详情仍不能唯一匹配时提供决胜偏好；它不限制候选查找，也不使复用影片自动加入目标库。

本地模式支持新建或追加自定义清单；远程模式当前只支持新建。收藏和稍后观看不能作为导入目标。导入不创建播放资源，不下载影片，不覆盖已有影片元数据或用户链接。

## 收集与身份处理

流程为“冻结输入 → 完整枚举清单 → 读取必要的详情 → 用户消歧 → 原子应用”。清单分页完成前不能进入详情阶段。

| 全局候选 | 处理方式 |
| --- | --- |
| 无完全匹配番号 | 按显式选项创建无资源影片或跳过；没有可靠番号时先读取详情 |
| 唯一影片 ID | 直接跨库复用，不主动读取详情或搬动归属 |
| 多个影片 ID | 读取详情，用发行商、日期和来源等强信号求交 |
| 强信号唯一命中 | 复用该影片，不被目标媒体库偏好覆盖 |
| 详情仍有多个合理候选 | 无冲突且目标库恰好有一条候选时决胜，否则交给用户；不自动合并影片 |

番号沿用全局规范化与逐字符完全匹配，不使用包含、模糊搜索首项或删分隔符匹配。唯一番号复用是本用例策略，不是新的全局唯一键。预览和提交前重校验共用身份模块，用户选择也须校验当前候选修订。

普通分页、加载更多和有限虚拟滚动都须形成当前 Session 检查点。虚拟窗口在 DOM 回收前固化候选和顺序，稳定绝对位置证明连续性；单次到底不能证明完整。重复 URL 可以保留多个来源 occurrence，但正式影片按既定身份去重。无法证明连续性、总数、分页终点或页面已变化时明确失败，不用截取前 N 项冒充完整导入。

## 会话与浏览器

任务仅在当前进程和浏览器 Session 内继续；软件退出、主进程终止或浏览器会话丢失后不恢复导入，也不重放旧滚动链。可重试错误从当前未封存页顶部重读，同一 Session 内幂等处理丢响应的检查点与提交。

通用浏览器负责导航、观察、受限交互和人工接管；领域工具独占 frontier 推进、连续性判断和检查点。共享 `viewRevision` 随滚动改变，旧 ARIA ref 失效；页面内容不能改变冻结的目标或工具授权。取消停止后续工具并清理暂存，不能留下空清单或部分应用。

## 正式应用

创建、复用、清单顺序和所需成员关系由共享写入用例在一个资料库事务中提交。新建目标仅在最终事务产生；追加保留原清单信息和既有顺序。远程预览、版本令牌、图片与工作库存储边界遵守[服务端合同](SERVER_MODE_CONTRACT_INVENTORY.md#共享用例与结果校验)，不把前台 TEMP 数据当服务端永久业务表。

自动创建无资源影片、保存详情相关链接默认开启；保存来源清单链接默认关闭。影片已被任一清单引用时，自动无资源清理不能删除它；用户显式删除仍有效，最近播放不构成这种保护。清单影片读取和资源筛选按全局资源事实聚合，不按导入目标库截断。

## 代码与回归

- [playlistImportModule.ts](../apps/desktop/src/main/services/playlistImport/playlistImportModule.ts)：目标验证、Session 控制与外部接口。
- [playlistImportIdentity.ts](../apps/desktop/src/main/services/playlistImport/playlistImportIdentity.ts)：候选证据、自动复用及预览有效性；不推进任务或正式写入。
- [playlistImportRepository.ts](../apps/desktop/src/main/services/playlistImport/playlistImportRepository.ts)：当前连接的 TEMP 状态、页面检查点和事务推进。
- [playlistImportRunDriver.ts](../apps/desktop/src/main/services/playlistImport/playlistImportRunDriver.ts)：Agent、浏览器与领域工具接线。
- [playlistImportWrite.ts](../packages/library/src/catalog/playlistImportWrite.ts)：桌面与服务端共用的正式提交。

相关同名测试覆盖全局候选、陈旧预览、幂等重试、页面连续性、人工接管与取消。通过范围按实际测试和平台分别记录，不能从早期版本的实现状态推定当前任意站点或安装包已验收。
