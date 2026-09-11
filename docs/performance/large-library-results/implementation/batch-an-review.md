# AN static review

Baseline4c953a9, cumulative working tree after AM. Reviewers read only, no tests or benchmarks run by them.

## Standards — Anscombe

No concrete blocker. Combined100 safe IDs at IPC/Repo, library-scoped group/identity and global scrape, same read transaction, settings full-query and prop removal. Page selection precedes presence lookup. Existing scanHandlers direct-repository style retained; prior ABA identity preserved.

## Spec — Ptolemy

Initial P2: clearing groupId while loading/error changed the DOM anchor, losing all-to-failed focus before a delayed response. Fixed by retaining historical groupId and only changing requiresAttention/pendingTarget. Gone group test confirms stable anchor/no action. Reviewer confirmed fix and delayed browser fixture design; coordinator then ran the final fixture successfully at both sizes.

heldFocus comes from document.activeElement before releasing the pending API promise. finalAnchor is only the row attribute after clicking its action; not a claim about post-click activeElement. Fixture verifies hidden action during loading then scan201 after release. This is component/mock IPC evidence, not entire native settings navigation.
