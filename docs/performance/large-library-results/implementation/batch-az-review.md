# AZ review and evidence boundaries

User explicitly approved removing work-count ordering. Final target SQL reads only actresses.id/main_name using the shared AY path predicate, ordered by ID. No work counts, memberships or gallery/profile projection. Standards reviewer 01a0895e-3d4f-7b93-887b-d7e6d6f24a85 and Spec reviewer 01a0895e-3dbd-78e3-abef-f3ab66f8ffd6 reviewed this final contract with no blocker; neither ran tests.

Provider sets a startup guard before the first await, acquires the existing mediator lock before reading targets, rejects concurrent startup, and avoids startup after unmount. Empty/failed reads and late lock completion release ownership. Actual Provider tests cover these paths and normal ordered processing [7,2] with skipped sources and final single lock release. No processing latch directly asserts that end never occurs early; static handoff is correct. Active-task unmount behavior, pending-array shift and unbounded logs are pre-existing and still open.

Repository oracle projects legacy targets then explicitly sorts by ID per user authorization; fixture work ranking differs from ID order. Complete names and target fields are equal, including long Unicode, NUL/space path cases and zero-work actors; statement assertions reject relation access. Initial test fixture attempted to create a membership in an already archived library and was corrected to archive after membership creation; this was not a production failure.

Benchmark synthetic10k actors,4KiB profiles,100k videos/edges,150k memberships,6667 avatar targets. ANALYZE and warm-up then3warm samples, fixed legacy-first order; oracle retained, timings exclude assertions/serialization. Legacy full IPC-equivalent DTO45,421,022B/170.326ms median vs narrow target292,612B/1.041625ms. Not a p95/cold/Windows/HDD/IPC roundtrip/peak-memory measurement. Full target list and sorting by primary key remain; not bounded pagination. No schema/user-data/media/commit/push/release changes in this batch. Cumulative selected patch depends on earlier batches, not standalone.

Final npm test exited0:2273passed,1skipped,0failed(2274total).
Production build exited0.
