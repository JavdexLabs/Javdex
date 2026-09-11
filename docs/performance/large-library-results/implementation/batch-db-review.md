# DB review: bounded request-local NFO directory reuse

Scope: default local NFO adapter anchor construction and direct collection, bounded cache, tests, synthetic real-adapter probe. Source patch is cumulative relative to the recorded base and depends on earlier batches.

Independent final static review found no concrete blocker. Successful directory context is keyed by library/root/lexical directory, preserving name-only filtering and original sidecar ordering. New invocations re-read. Failed reads are not cached; a failed production anchor retains its old fallback and can retry during collect. A direct failure uses an empty map only for that anchor. Explicit caller maps, including empty maps, are authoritative and never seed shared cache. Locator issue/read authorization still occurs per file before physical deduplication.

An intermediate design retained unbounded sidecar maps on production anchors; it was revised before acceptance. Each phase now admits at most64 scopes and1MiB of encoded dynamic cache strings. Combined production and collection retention is at most128 scopes/2MiB of those strings, not whole-object or heap memory. Rejected production maps are not attached to anchors; direct rejected maps are used only for the current anchor. No eviction, unbounded rejection set or truncated output. Existing caller inputs, nonadmitted summaries, transient listing/map allocations and JS overhead are excluded.

Tests cover actual default24-resource collection48 listings->1, failed-first production listing3 reads then next request1, added/deleted sidecar and sibling refresh, complete candidate/warning equality, provided-context precedence, foreign-root rejection and actual DB root disabling after the first file. The root-revocation test still issues all3 file checks and returns only the first candidate. Additional tests prove65 scopes, exact encoded byte boundary, rejected budget not consumed, oversized direct3 reads and oversized production48 reads with complete results, and no hidden rejected maps on anchors.

Final isolated real-adapter probe:100 resources200 listings/32.66–34.94ms before versus1 listing/9.55–10.10ms after;1000 resources2000 listings/2410.44–2433.81ms before versus1 listing/84.13–85.58ms after. One warmup and3 samples, title-only collection, real catalog and authorization. Fixture setup/candidate application/full scanning, cold disk/p95/Windows/HDD/concurrency/peak RSS are excluded. Final numbers include cache budgets.

A final gate found implicit-any parameters in a new mock; it was corrected using Parameters<typeof original>, with typecheck and affected tests passing. No production behavior or test expectation was weakened. Final full/build outcomes are recorded in archived logs/manifest.

Remaining: resource/anchor full lists, transient oversized directories, other asset searches, scanner preflight/NFO queues, CY synchronous cleanup and full performance/platform/recovery matrix. Full15/42 remains incomplete.
