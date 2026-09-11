# AX review and evidence boundaries

Standards reviewer 01a0895e-3d4f-7b93-887b-d7e6d6f24a85 and Spec reviewer 01a0895e-3dbd-78e3-abef-f3ab66f8ffd6 completed final static review with no remaining blocker. They did not run browser/tests. Spec requested merge-error/page-error/retry interleaving assertions; these were added and passed in the six focused tests.

The first browser attempt failed trying to check a visually hidden radio; the visible label intercepted pointer events. This is a harness interaction failure, not evidence of a layout bug. Independently its screenshot revealed real picker/plan overlap at 1000x640. The body now scrolls, flow does not shrink, and picker reserves 280px. Final browser geometry verifies no section overlap and scroll-to-pagination reachability at 1000x640 and 1440x900. Error scrollIntoView makes the complete merge error visible above fixed actions; both final screenshots were visually inspected. It does not call focus; activeElement preservation on error is not dynamically asserted.

Actual component/styles, synthetic API fixture: 101 candidates, page40/40/21, search/reset, separate page retry, selected-ID and main-name-plan preservation, failed merge then retry, busy controls/Escape suppression, exact two merge payloads, no pageerror/horizontal overflow. Legacy full list throws. Interaction tests additionally cover same-tick duplicate submission, stale page responses and keep-identity changes during reads/merge.

No native IPC timing, real database mutation, memory peak, cold disk, Windows/HDD or p95 claims. AW backend snapshot/count tests and benchmark remain prerequisites; a high-fanout candidate still has expensive counting. Other actor candidate entrypoints and entity detail paths remain open. Patch is selected cumulative diff versus HEAD plus full new files, depends on earlier batches and is not standalone.

Final npm test: 2266 passed, 1 skipped, 0 failed (2267 total), including the last fixture keepId exclusion. Production build exited 0. Browser3 process handle had expired on resume; its complete results.json contains both successful viewport records and the final log matches it. No invented second terminal observation.
