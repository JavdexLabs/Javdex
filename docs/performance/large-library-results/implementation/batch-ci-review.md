# CI review

Scope: scanner tail NFO batch/anchor processing, primary selection, and final audit delivery cooperative scheduling.

Before-change actual scanner regression: 66 pass, 2 new failures. The first NFO apply queued setImmediate but all 30 applies ran before it; the first audit callback queued setImmediate but all 30 entries had already been delivered when it ran. Existing committed resource/audit/primary assertions passed, isolating starvation from data loss.

Pre-review found no transaction or native DB iterator held across these tail loops. Keep a whole primary read/select/authorize/write operation synchronous. Coordinator lease remains held through scan completion. It does not prevent all other writers, so per-item fresh reads and authorization remain necessary.

Final static production review found no added blocker: continuous anchor counter includes skipped missing anchors, current NFO batch audit is drained on cancel, next batch checks abort; primary yields only after complete item, audit loop never breaks on cancel, final abort check records cancellation during drain. NFO apply errors still become warnings; primary/callback errors still propagate. Do not claim unconditional full audit delivery on arbitrary exceptions.

No schema or persistent format changes. No partial transaction commits introduced. Counts bound scheduling opportunities, not wall-clock time or native operation latency; a single NFO apply remains non-preemptible. No user DB/media access, commit, push or release. Full 15/42 plan remains incomplete.

Source patch is selected cumulative diff against base and depends on earlier batches.

Final focused: 108 passed. Single-batch anchors test intercepts actual anchor consumption and observes abort before any audit callback; first callback sees abort, all 30 entries preserve imported NFO results. Primary test instruments actual per-item UPDATE, observes partial completion and no active DB transaction before audit starts, then confirms all 30 primaries/audits complete after abort. Instrumentation restored in finally. Existing conflict controller test remains +27/-0.

Additional tests statically reviewed with no blocker. Final full: 2508 pass, 1 skip, 0 fail; build terminal exit0. Parent observed focused/full/build terminal completions.
