# AV review

Standards reviewer01a0895e-3d4f-7b93-887b-d7e6d6f24a85 and Spec reviewer01a0895e-3dbd-78e3-abef-f3ab66f8ffd6 completed static reviews. No remaining identified blocker.

Spec identified owner-command invalidation gap: a pending external choice could override a newer direct owner command. Real Page/VM-command interleaving regressed2001vs1001 before the guard; direct-owner and submit now invalidate choicegate. This proves the command contract, not a confirmed checked-radio user trigger. Browser separately verifies close/reopen and a newer choice survives the held older response. Page tests also cover A-B-A, stale submit, debounce/current page, selected actor offpage, errors/retry and rapid choices.

Final scope corrected selection reads from wide get to pickerGet narrow identity, avoiding full works/profile load. New service/typedIPC/preload/repository path shares AU bounded label/avatar mapper and returns current revision. Ownership writes ID/revision only; label is display-only. Selected avatar stays from page snapshot, no fresh-avatar claim. Identity tests include1MiB profile not projected, missing actor, ID constraints, revision changes/NUL and<5KiB result. Fake Page/browser forbid wide list and get calls.

Final59focused passes preceded only internal remote method rename; final full2254pass1skip0fail(2255total), build passed with final source. Original controller tests preserved27adds0deletes vsHEAD. Browser final passed1000x640/1440x900 with actual Page/router/styles + synthetic IPC,40/40/21 rows, search reset/error retry/selection preservation and old-response isolation; both final images viewed. Pager uses shared32px Button sm, no horizontal overflow/pageerror. Not native IPC/backend timing or mobile/Web UI acceptance.

No historical candidate-page accumulation, but logical stale-response suppression is not native IPC cancellation or global inflight limits. Search/deep OFFSET, other candidate entrypoints, large conflict groups and complete hardware/fault matrix remain. No user data/schema/commit/push/release; full15/42 goal active.
