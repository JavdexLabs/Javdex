# DA review: NFO directory identity summaries

Scope: immutable directory identity helper, scanner context accumulation/lifetimes, locator and adapter input contracts, regression tests and the pure predicate benchmark. Selected patch is cumulative relative to the recorded base.

Independent static review found no concrete blocker. Summary counts preserve empty/singleton/multiple semantics, including a singleton null or blank value. Full scans still accumulate from the existing files sequence; targeted scans still count actual siblings once. Literal directory keys and existing normalization remain unchanged. Scanner anchors share immutable completed context. Manual directory helper retains its original filter/sort/array path; the array predicate no longer allocates an intermediate normalization array.

NFO-disabled scans skip identity/sidecar indexing. Before the apply tail, files and outer lookup containers are cleared; queued anchors retain needed summary and sidecar references. Existing NFO/primary/audit cancellation-drain coverage remains. Added tests cover120 same-code parts, real adapter array/summary differential for movie.nfo/exact sidecar and generic poster/fanart ownership, targeted duplicate requests, scheduled preflight cancellation, and disabled modes. Pure oracle tests cover null/blank/normalized-equivalent/mixed identities and immutable earlier snapshots.

The original scanner-array regression was observed failing with terminal exit1. Final isolated pure predicate comparison includes one summary build plus one eligibility check per anchor,1 warmup and3 samples. At5000 same-code anchors, frozen old predicate403.73–406.75ms versus summary0.230–0.268ms. Raw codes are fixture input; filesystem discovery, filename parsing, NFO parsing/application, audit, IPC and peak RSS are excluded. This is not an end-to-end speedup or p95 claim.

Full gate initially caught the new test importing a private metadata-source implementation. It now uses the existing public index; no boundary rule was bypassed. The boundary check and7 new scanner tests passed after the fix. Final full gate outcome is in the manifest/log.

Remaining: whole-file discovery/preflight/NFO anchor peaks, sidecar/readdir costs, manual per-anchor directory reads, CY synchronous cleanup latency and the broader platform/long-run/fault matrix. Constant fields retain one code string and are not an arbitrary input byte bound. Full15/42 plan remains incomplete.
