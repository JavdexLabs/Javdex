# CZ: compact scan completion review

Scope: scanner result modes and fatal counters; shared completion contract/field projection; coordinator, IPC, automatic scheduler, notification and renderer consumers. Base remains the recorded uncommitted implementation branch; selected patch is cumulative.

Independent static review found no concrete blocker in the implemented scope. Default entries initializes only the unknown counter and does not collect newCodes/unrecognizedFiles. Explicit modes keep direct scans and JSON detailed. Normal/early/cancel returns and completed events use a runtime field allowlist. Fatal partial results transfer the matching result representation; both unknown branches count only after audit persistence succeeds, while scannedFiles remains attempts. Ordinary processing failure classification still suppresses unsafe cleanup.

Tests verify detailed/summary equality, real local and STRM fault/cause/partial, cancellation, summary requiring a sink, retained imports, extra-field stripping, duplicate requested paths producing2 unknown attempts but1 final audit row, and actual1/300 unknown-file summaries at297/303 JSON bytes. Coordinator real scan/NFO tests exercise production summary mode, historical JSON, failed/cancelled publication and cleanup preservation. Renderer tests accept compact IPC/event completion and suppress duplicate completion. The600k notification fixture tests numeric classification only, not a600k scan.

Limits: no total scanner RSS, arbitrary IPC byte bound, p95, Windows/HDD, prolonged concurrency or real process-crash acceptance. Offline roots/STRM diagnostics and discovery/preflight/NFO collections remain; CY synchronous cleanup target still unmet. Full15/42 plan remains active.
