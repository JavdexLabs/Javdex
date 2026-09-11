# AY review and evidence boundaries

Standards reviewer 01a0895e-3d4f-7b93-887b-d7e6d6f24a85 and Spec reviewer 01a0895e-3dbd-78e3-abef-f3ab66f8ffd6 found no static blocker. Neither ran tests. Nullable TEXT path predicate matches legacy JS truthiness for all genders, including whitespace and embedded NUL; it intentionally does not inspect file existence or usability. Typed no-argument count is wired from repository to service, handler, preload and actual Provider.

31 focused tests passed. Real Provider regression throws if the old full-list path is used; temporary restoration of that old callback failed exactly with Full target list forbidden for counting, then finally restored final source. Provider verifies dynamic numeric values, rejection propagation, idle task state and unsubscribe. 300382 in this test is a synthetic scalar, not a benchmark population. Repository tests compare 75 gender/path combinations with the legacy list/filter oracle and verify single COUNT without work/gallery/profile projection or sorting, followed by empty-database result.

Full npm test exited0:2270pass,1skip,0fail(2271total). No new production change after this run. COUNT still traverses actor path fields; task-start target enumeration/order and queue memory remain unchanged, as does the count-to-start race. No schema/user-data/media/commit/push/release changes, no p95/Windows/HDD/cold/IPC timing or memory claims. Selected patch is cumulative vs HEAD plus full new tests and depends on prior batches.

Production build exited0.
