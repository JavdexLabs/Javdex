# ADR-0008：冲突 review session 与收窄 ViewModel

演员名称冲突页的复杂度来自两处：纯决策状态（selection / dialog / refresh 焦点）与跨请求副作用（debounce、latest-request gate、resolve/discard + toast）。二者拆成独立模块；页面只消费嵌套 ViewModel。

## 两条 seam

1. **`ConflictReviewSession`**（[`conflictReviewSession.ts`](../../apps/desktop/src/renderer/src/pages/conflictReviewSession.ts)）
   - 拥有：`ConflictReviewSessionState`、`reduceConflictReviewSession(intent)`、`deriveConflictReviewDetail`。
   - 不拥有：fetch、toast、debounce、React Query。
   - 继续组合 [`actressConflictReviewState.ts`](../../apps/desktop/src/renderer/src/pages/actressConflictReviewState.ts) 的纯领域 helper（queue 分段、snapshot、merge actors、refresh 焦点算法）。

2. **`ConflictReviewRemote`**（[`conflictReviewRemote.ts`](../../apps/desktop/src/renderer/src/pages/conflictReviewRemote.ts)）
   - 拥有：owner search、live name inspection、replacement validation、resolve/discard、chooseOtherOwner 的异步编排。
   - 依赖注入：`api` / `toast` / `invalidateLibrary` / `refetchGroups`，以及 `LatestRequestGate`。
   - 只回传 session patch / outcome callback，不直接持有 UI state。

`useConflictReviewController` 只做接线：React Query、`useDebounce`、把 remote 结果 dispatch 进 session，并组装页面唯一消费面 `ConflictReviewViewModel`。

## 页面 ViewModel 四块

[`ActressConflictReviewPage.tsx`](../../apps/desktop/src/renderer/src/pages/ActressConflictReviewPage.tsx) 只解构：

- `queue` — 列表、选中组、stale/focus、`chooseGroup`
- `detail` — selection、来源/归属、打开次级动作、confirm/apply/discard 请求
- `dialogs` — otherOwner / editName / merge / replacement / discard
- `busy.resolving` — 全局提交中禁用

禁止再把 session 内部字段（gate、raw `liveEditInspection`）平铺给页面。

## 必须保持的 invariants

- latest-request：旧 search / inspect / validate 结果不得覆盖新请求；unmount 时 invalidate。
- resolve 单飞：`resolving === true` 时忽略新的 resolve。
- stale resolve → toast info + `staleMessage` + 清 replacement dialog + 既有 refresh 焦点算法。
- 切组清 transient dialog（otherOwner / editName / merge / replacement draft）。
- 后端契约不变：仍走现有 `api.actressScrape.*` / `api.actresses.*`。
