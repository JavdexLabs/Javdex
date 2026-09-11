# CA acceptance

Scope: optional combined audit view index, shared actual-panel item builder, and reproducible large-document probe. No worker/session/IPC view wiring or frontend pagination cutover yet.

Two independent read-only reviews found no semantic blockers in combined order/dedupe/key/navigation/anchor/readonly transaction logic. Spec review identified repeated all-candidate ranking/search on every page. Replaced this with a single TEMP matched-position table; rereview confirmed page/limit reuse, invalidation on filter/search/locale, prior-table release, failure rollback and query_only restoration. First query/filter change and anchor scans remain nonconstant; documented rather than concealed.

Validation: original memo oracle32 and shared/UI43 pass; raw/view9 focused pass. Search call-count and real TEMP exhaustion/recovery test added. Initial test instrumentation needed fixed three-argument UDF arity; page-full fixture now fills remaining freelist space rather than assuming page_count alone means full. Final lint/typecheck required captured-connection storage and explicit this type, without weakening assertions. Final npm test: 2421 pass, 1 skip, 0 fail; npm run build terminal0. Existing conflict controller regression remains +27/-0 against HEAD.

Benchmark before-cache and final logs retained; final probe records first query construction separately from warm reads. Initial indexBytes excludes later matches table and is not runtime total. Full legacy oracle retained; no p95/cold/platform/peak/IPC/UI claim. The before-cache log was produced before adding firstReadMs instrumentation, using the same fixture, queries, warmup and sample loop; the source before-cache snapshot is archived.

Oracle replay: restore batch-ca-items-before.tsx as /tmp/LibraryScanAuditPanel.before-items-extraction.tsx and batch-ca-shared-before.ts as /tmp/scanAuditView.before-items-extraction.ts. Run archived oracle-build.cjs from repository root to generate /tmp/scan-audit-items-oracle.cjs and its preload; original path assumptions are retained explicitly. The generated oracle/preload/TypeScript and identity check log are also archived. The selected cumulative patch depends on earlier batches and is not an independent sequential patch.

Remaining: combined worker/session/typed IPC integration, no-audit/persistent-unrecognized path, header-to-page run changes, actual getLatest replacement, UI lifetime/presence/anchors/errors, source/index protection limits and platform acceptance. Full 15/42 goal stays incomplete.
