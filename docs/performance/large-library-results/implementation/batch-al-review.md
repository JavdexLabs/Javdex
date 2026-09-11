# AL static review and evidence scope

Baseline4c953a9, cumulative working tree after AK. Reviewers read only, no tests or benchmarks run by reviewers.

## Standards — Anscombe

Initial P3: scrapeOffset literal bypassed the required LIST_PARAM registry. Fixed by adding pendingScrapeOffset and consuming it in parser/builder. Final no new blocker; summary-only state and URL-normalized detail mounting verified. No full DTO compatibility branch remains in queue projection.

## Spec — Ptolemy

Initial P2s: independent scrape-count failure blocked unrelated queues; disabled page total overrode refreshed count. Fixed by active-page/inactive-count separation and error scope; count error displays unknown without replacing unrelated queue. Detail waits for URL canonicalization. Final static review closes both P2s.

Interaction evidence covers a healthy empty scan queue despite count failure, not confirmation of a nonempty scan item. Browser final assertions record exactly[1,51,101] details. Initial deep link, stale detail/page, final-page deletion and disabled same-key count change are exercised by actual React page tests.

## Benchmark evidence

Reviewer checked script and JSON values: medians and JSON-equivalent bytes agree. Repository-only timing excludes serialization/assertions. Full list runs first, affecting cache/GC; RSS about1.41GB is neither peak nor independent stage allocation. ANALYZE was run; fixture is one source and one candidate per item. Homepage has full50-item equality assertion; deep page checks offset and membership, selected detail checks ID and summary length, not equality of every field. Does not prove p95/full IPC/Windows/HDD or all distributions.
