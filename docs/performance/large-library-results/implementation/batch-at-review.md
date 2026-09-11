# AT review and scope

Standards reviewer 01a0895e-3d4f-7b93-887b-d7e6d6f24a85 and Spec reviewer 01a0895e-3dbd-78e3-abef-f3ab66f8ffd6 found no blocking static issue in materialized normalized-name membership SQL. Parameter order, excluded pending/actors, DISTINCT/order and active-conflict selection preserved. NULL normalization has matching WHERE behavior. No schema changes.

Deterministic public workflow regression failed at 5,549 normalization calls /100 names before SQL change and passed the <=500 bound afterward, preserving third-party blocking. This is a fixture work bound, not strict exact-once or global linear-time proof. Final full suite2238pass1skip0fail includes final test name.

Spec requested an actual old-SQL replay interception assertion; final probe has legacySqlReplacements=1, public get complete objects deepEqual, prepare restored in finally. New4.006/old151.784ms are fixed-order single observations, not a stable ratio. Old full-list API in the final probe uses new SQL internally.

Initial pre-fix1000 stage probe observed legacy.no-field-plans running >34s and was intentionally terminated by SIGTERM; not a completed timing or a new180s timeout. Original AR1000 benchmark source (batch-ar-benchmark-1000-source.ts) was copied byte-for-byte into scripts/performance for relative imports, replayed successfully with AT production code, verified identical, then removed. See replay JSON for3warm medians and constraints. It no longer triggers the aggregate runner timeout in this environment.

Benchmarks and full/build checks were run serially. No user database/media, schema changes, commit/push/release. Full15/42 objective remains active, including single-group pair explosion, globally growing metadata, target hardware and fault/long-run matrix.
