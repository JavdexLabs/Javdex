# AU review

Standards reviewer01a0895e-3d4f-7b93-887b-d7e6d6f24a85 found no blocking issue in bounded picker repository/service/IPC/preload. Spec reviewer01a0895e-3dbd-78e3-abef-f3ab66f8ffd6 identified SQLite TEXT length ending at NUL, letting abnormal long names bypass the display bound. Regression reproduced600002vs129 code points. Fixed by SQL BLOB prefix516bytes and JavaScript Unicode truncation to128+ellipsis; full name still controls ordering. Spec closed P2 after static review of that change and worst-case escaping tests.

Default40/max100, limit+1 hasMore, no totals/stats/full profile. Search keeps owned normalized names, all gender/status, max256 UTF-16 input units. Name sorting intentionally differs from legacy video_count order. JSON avatar cap4096bytes, name<=128codepoints+ellipsis;100-item control-character/backslash fixture<512KiB. Do not use truncated labels for edits; fetch detail by ID.

Focused30 tests passed before final worst-case JSON case; final full2245pass1skip0fail(2246total) includes that extra case. Build passed. Benchmark10k actors4KiB profile, no videos/gallery, ANALYZE, warm-up then3warm samples; first/deep/search IDs match legacy projection in this equal-video-count fixture. Median111.508ms/45.33MB full vs0.0567ms/2228B first40. No cold/p95/Windows/HDD/IPC/frontend or peak RSS claim; oracle retained in memory. Search and OFFSET remain data-dependent.

Backend preparation only: renderer owner dialog still calls legacy full list. Next step must wire real pagination, request/session isolation, selection persistence and error/retry/browser acceptance. No schema/user-data changes, commit/push/release. Complete15/42 goal remains active.
