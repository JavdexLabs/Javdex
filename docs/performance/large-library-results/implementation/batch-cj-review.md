# CJ prototype review

Not shipped: no production imports, schema migration, or writer/reader switching. Question: mutable per-run audit batches, stable file keys and NFO revisions, seal/publish atomicity and recovery.

Review identified a budget gap: body-only patch acceptance could produce an unreadable single-item page. Fixed with full single-item response checks on writes/patches; repeated keys use the original ordinal. Page preflight now reads lengths only, including JSON-encoded key size. Near-limit patch and oversized-key-page checks pass.

Final review found no remaining blocker within the prototype scope. SIGKILL harness owns both scratch children, waits for ready, kills that child, waits for confirmed exit, then reopens. The publication case uses an uncommitted outer transaction/savepoint for deterministic rollback. This is not power-loss or arbitrary COMMIT interruption evidence.

Four prototype checks pass, including 100k generated entries, bounded input batches, page budget, publication fault rollback, scoped access and recovery. Selected tsc passes and its file list includes all three prototype files. Repository ESLint ignores scripts: archived warnings are not a successful lint gate. No full application test/build was rerun because production code is unchanged; previous CI acceptance remains 2508pass1skip/build.

Known open work: application readers do not recognize new format (actual header returns null snapshot, explicitly asserted), formal migrations and schema validation, producer backpressure, source Map/array removal, atomic business/audit journal boundary, disk quotas/retention, cancellation and exit handoff, target-platform/fault matrices. Full15/42 not complete.

Source artifact contains new prototype files only. They depend on the current repository and native runtime; do not apply as a production migration or load into user data. No commit/push/issue comment/release.
