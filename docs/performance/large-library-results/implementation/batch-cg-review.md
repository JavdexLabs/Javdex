# CG review

Scope: finishLibraryScanRun root-set filtering and replacement DELETE parameters; new transaction and lock-boundary regressions.

- Standards static review found no blocker: numeric root IDs preserved, Set.has/includes matching equivalent, root deduplication and library predicate unchanged, inserts retain composite FK, all finish updates/deletes/inserts remain in one transaction.
- Parent inspected actual production diff (four local substitutions), before/after benchmark script and results. Root parameter failure reproduced before fix. Targeted suite final: 49 passed, 0 failed.
- Added cross-library target-root isolation, absent/empty/duplicate root handling, failed/cancelled preservation, duplicate-path rollback of run/state/files and retry.
- Independent connection with timeout zero writes during intercepted audit stringify. Deferred BEGIN alone does not establish writer lock before first SQL; do not claim moving stringify alone would eliminate writer-lock cost.
- Benchmark result is mixed: 1000 roots improves, 1/100 roots do not. Retain the fix for the demonstrated parameter-capacity failure and removal of O(files × roots) membership checks, not as a universal latency win.
- Benchmark captures production SHA and checks it at end. Baseline SHA matches HEAD libraryScanRepo.ts. Three hot samples are not p95/cold/platform/peak evidence; all row/summary/audit results validated after commit.
- Existing useConflictReviewController.test.tsx remains +27/-0 vs base. No user DB/media access, commit, push or release. Full 15/42 plan remains incomplete.

Patch is selected cumulative difference versus base plus new benchmark, and depends on earlier batches.

Final full: 2488 pass, 1 skip, 0 fail; build terminal exit0. Baseline benchmark terminal exit0 confirmed by owning agent; after benchmark terminal exit0 observed by parent.
