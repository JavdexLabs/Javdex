# CF review

Scope: pendingScanAuditRepo and scanCoordinator.refreshPendingAudit, plus targeted tests and synthetic probe. Existing cumulative changes are not reclassified as this batch.

- Spec reviewer: no blockers; updated_at/id order, library scope, zero groups, exact global pending path counts, and same-transaction snapshot preserved. Pending paths with no group ID still participate.
- Standards reviewer found a prepare-failure iterator lifecycle gap: groups.iterate was created before resource prepare. Fixed by preparing both statements before entering group iteration. Added injected resource prepare failure check for transaction exit, subsequent write and journal mode operation. Follow-up static review found no remaining blocker.
- Parent focused suite: 36 passed. Final full test: 2478 passed, 1 skipped, 0 failed; initial full preceded the final added failure test and is not used as final acceptance.
- Four benchmark scenarios pass old oracle and independently specified order/counts. Temporary synthetic data only, one warmup and three hot samples, alternating timed method order. No cold/platform/p95/peak or whole scan claim.
- Existing useConflictReviewController.test.tsx remains +27/-0 vs base.

Selected cumulative patch depends on earlier batches. Full 15-package/42-risk plan remains incomplete. No commit, push, release, or user database access.
