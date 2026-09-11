# CY review: resource-less membership cleanup

Scope: libraryMembershipRepo synchronous visitor, default entries coordinator wiring, tests, and synthetic probe. Reviewed against current working tree; selected patch is cumulative relative to the recorded base.

Independent static review found no concrete blocker in this scope. Initial candidates and metadata are frozen in a TEMP table; each completed read returns at most256 rows before delete/callback. DELETE retains qualification rechecks and only actual removals are audited. The same transaction covers cleanup and writer savepoints. Rejected/resolved thenables are observed and rejected; rollback removes TEMP state. The coordinator adopts the count only after its enclosing cleanup commits. JSON and legacy array API remain compatible.

Evidence: repository tests cover1030 ordered candidates with page lengths256/256/256/256/6/0; pinned/playlist/current-library resource exclusions; other-library resource semantics; changed eligibility/metadata, new candidates, IGNORE; long untruncated names; native audit failure with nested writer/outer mutation rollback and retry. Coordinator tests cover260 removals, shared memberships/global videos, exact order/counts, failure on the202nd audit insertion with an independent reader and retry, and explicit JSON.

Limits: static review is not a full-plan acceptance. Row count alone is not a byte bound; full names and SQLite TEMP may grow. Cleanup remains one synchronous transaction. Probe10k/100k excludes real audit writes, durable commit and filesystem work;100k still takes304–357ms, exceeding the plan's250ms candidate limit. No p95/RSS/platform/crash completion claim.
