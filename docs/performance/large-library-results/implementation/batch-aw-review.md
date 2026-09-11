# AW static review and acceptance

Standards reviewer01a0895e-3d4f-7b93-887b-d7e6d6f24a85 and Spec reviewer01a0895e-3dbd-78e3-abef-f3ab66f8ffd6 found no semantic blocker. Actual keep gender read in the same transaction; unknown/null→female, owned-name search and self exclusion preserved. Page before count, only returned IDs count, empty skips. video_actress PK + active-visible membership EXISTS avoids cross-library double counts. External WAL write test verifies current snapshot and next-read visibility.

Spec noted that page-ID parameters alone do not prove limited relation access. Final benchmark added200k works to off-first-page actor9998 then ANALYZE; parameterized EQP still SEARCH va USING INDEX idx_video_actress_actress_id, membership video_id index, library PK. First-page median0.315ms before vs0.324ms after skew; last-page9.878→75.347ms exposes actual high-fanout cost. Not constant work or a universal optimizer guarantee. All returned candidate fields/counts compare with legacy semantic oracle, explicitly reordered by full name.

34focused and full2260pass1skip0fail(2261total); build passed. Benchmark10k actors4KiB profile/100k edges/150k memberships; skew totals300k edges/videos and350k memberships. Warm-up+3warm samples, no p95/cold/Windows/HDD/nativeIPC/UI or peak memory claim. Oracle remains live, timing excludes assertions/serialization.

Backend only: MergeActressModal still reads legacy full list. Next must wire pagination and preserve selection/merge plan/error handling. No schema/user-data/commit/push/release changes; full15/42 objective remains active.
