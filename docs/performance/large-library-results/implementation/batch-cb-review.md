# CB acceptance

Scope: combined audit views through shared worker/client/session and strict typed IPC/preload. Existing UI still uses getLatest; no frontend-cutover completion claim.

Independent Spec review checked pre-allocation input copying (including nested anchors), operation separation, raw-to-views release before upgrade and views-to-raw reuse, unified revision/budget/failure/idle/dispose lifecycle. Standards review additionally checked two-argument strict IPC, fixed trusted budgets, valid locale/anchor constraints and actual preload-to-reader wiring. No unresolved blocker found. Single-query TEMP cache still rebuilds on filter changes; shared worker search delays other queued work.

Parent focused85 pass. Full npm test2429pass1skip0fail and build terminal0. Existing conflict-review controller regression stays +27/-0 versus HEAD. Initial integration fixture used a dynamic @shared import unsupported by this test ESM resolver; replaced with normal static alias import used by neighboring tests. No assertion removed.

Real-worker300k fixture: startup/index/first query1788.417ms; main-thread 2ms timer716 callbacks, max gap6.447ms including8ms drain. Deep-page warm samples1.589/1.389/1.370ms. One tag queued after first search waited675.161ms. This documents remaining shared-slot contention rather than proving general fairness. Source oracle retained; no peak/p95/cold/platform/actual IPC UI claim.

The patch is a selected cumulative source snapshot against HEAD, with new-file bodies. It depends on CA and earlier batches, not a sequential standalone patch. No persistent schema migration, user database/media access, commit, push or release this batch.

Remaining acceptance: no-audit-body/persistent-unrecognized view, header/page run-change semantics, actual getLatest cutover, presence and UI query/cancellation/anchor/error behavior, broad source/index protection and platform matrix. Full15/42 remains incomplete.
