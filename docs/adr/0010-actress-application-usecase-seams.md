# ADR-0010：演员 application use-case seams

演员 IPC 入口曾集中在一个 24 方法的 `actressApplicationService`：列表头像快照与删除清理带有真正 policy，冲突通道却只是转交已有 workflow。宽 façade 抹平了深度差异。完成线 A 按 use-case 收窄为三条 seam；**不拆** `actressRepo`。

## 三条 seam

1. **`actressQueryService`**（[`actressQueryService.ts`](../../apps/desktop/src/main/services/actressQueryService.ts)）
   - 拥有：列表分页、头像可用性筛选与跨页 snapshot、face-scan manifest、详情与头像源信息读取。
   - 不拥有：写库、冲突决策、刮削 apply。

2. **`actressMaintenanceService`**（[`actressMaintenanceService.ts`](../../apps/desktop/src/main/services/actressMaintenanceService.ts)）
   - 拥有：编辑 / 删除 / 清元数据 / 合并、写真与海报、累计刮削成功标记。
   - Policy 示例：删除后资产清理失败收集；`clearMetadata` 经 `MediaAssetStore` coordinator。

3. **`actressIdentityConflictWorkflow`**（已有）
   - 冲突列表、inspect、validate、discard、resolve。
   - IPC 直连本模块，不再经 application 透传层。

[`actressHandlers.ts`](../../apps/desktop/src/main/ipc/actressHandlers.ts) 只做 typed adapter，分别委托上述三条 seam。`check-actress-boundaries` 白名单锁定该接线。

## 必须保持的 invariants

- 数据库 module 不触碰 `MediaAssetStore` / 文件系统。
- 媒体写入与清理经 `MediaAssetStore` 公开面（含 coordinator）。
- 不恢复宽 `actressApplicationService` 聚合 façade。
- 本 ADR 刻意不做 `actressRepo` 物理分组（完成线 B 另议）。
