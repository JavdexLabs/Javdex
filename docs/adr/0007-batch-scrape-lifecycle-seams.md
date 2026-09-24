# ADR-0007：批量刮削 lifecycle 与头像构图 mediation seams

批量刮削与头像智能构图共享同一组用户可见的「进行中」语义，但复杂度不同：前者要持久化 checkpoint、pause/resume/discard 与串行执行；后者要跨进程 request/response、超时与 renderer disconnect。二者拆成独立 deep module，由 `ScrapeJobController` 只做接线。

## 两条 seam

1. **`CheckpointedSequentialBatchQueue`**（[`checkpointedSequentialBatchQueue.ts`](../../apps/desktop/src/main/services/checkpointedSequentialBatchQueue.ts)）
   - 拥有：start / resume / pause / discard、`activeJob`、checkpoint persist cadence、outcome 分支（paused → markPaused，done → finish，cancelled → discard + resetToIdle）、`scrapeBrowser.close()`。
   - 依赖已有内核：`SequentialBatchQueue`、`BatchScrapeCheckpointPort`。
   - 影片/演员队列只提供 `CheckpointedBatchPolicy`（target 解析、文案、`runTarget`、actress `beforeResume` / crop hook），不再各自复制 lifecycle。

2. **`AvatarAutoCropMediator`**（[`avatarAutoCropMediator.ts`](../../apps/desktop/src/main/services/avatarAutoCropMediator.ts)）
   - 拥有：pending map、requestId、timeout、renderer disconnect、crop batch token（begin/end/hasActiveBatch）。
   - 依赖：`emit`、`rendererAvailable`、`randomId`、`autoCropTimeoutMs`，以及由 controller 注入的 `assertCanBeginBatch`（队列空闲 / 无暂停任务），避免 mediator 反向依赖队列。

`ScrapeJobController` 保留 IPC façade：单项 exclusive scrape、批量 progress 通道路由、count API，以及把 mediator 接到 actress queue listener。裁剪 lock 通过 `mediator.hasActiveBatch()` 阻挡新 batch / resume。

## 必须保持的 invariants

- 磁盘上最多一个 `batch-scrape-job.json`；存在 paused job 时不得 start 新 batch。
- 启动 `initialize()`（及 state 查询）须把 on-disk `status: 'running'` 收敛为 paused，才能安全 resume。
- Checkpoint cadence：每项完成后 `nextIndex = i + 1`；pause 时用当前 progress.current；resume 从 `job.nextIndex` 续跑，不重跑已完成项。
- Actress resume 必须走 `assertActressRecoverable` / 状态调和。
- 单项与批量 start 都经 `scrapeRunCoordinator` exclusive run（共享 scrape browser）。
- Crop batch token 阻挡新 scrape batch 与 resume；仅 matching `end` 或 disconnect 清除。
- Crop request 身份：超时 / disconnect 后的 stale `complete` 必须返回 `false`，不得解析新请求；默认超时 5s。
- Discard：running → cancel（cancelled 分支清 job）；paused → 立即 discard job。
- 批量结束 / 暂停 / 取消后关闭 `scrapeBrowser`。
- Actress 智能构图 best-effort：crop 失败只写日志细节，不把该项标为刮削失败。

## 明确不做

- 不改变 renderer 构图 UI 与 IPC channel 名。
- 不把 `BatchScrapeCheckpointPort` / `SequentialBatchQueue` 再拆一层。
- 不把单项 scrape 再拆成独立 `SingleScrapeService`（超出本 ADR 完成线）。
