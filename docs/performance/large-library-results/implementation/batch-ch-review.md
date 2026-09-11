# CH review

Scope: libraryRootMatcher, injectable lexical path predicate with unchanged native default, and the two actual scanCoordinator root lookups.

- Standards review found no lexical/order/authorization blocker. Candidate verification retains legacy predicate including root equality and ..hidden rejection, choosing minimum original ordinal. Relative/invalid/namespace roots fall back; current-drive-dependent Windows roots now also fall back.
- Follow-up review confirmed cleanup enables realPath while summary does not, actual authorize calls remain in present/missing/unknown branches, and failed first-root authorization never chooses a later root.
- Helper confirmed production scan snapshots freeze snapshot/config/roots array and individual roots, matching the matcher lifetime contract. No per-file result cache or filesystem authorization cache added.
- Final focused: 47 passed. Matcher tests compare object identity against old find for POSIX and Win32 lexical paths, Unicode/mixed separators, aliases and nested root order, fallback and short-circuit cases. The 1000-unrelated-root counter observes 1000 old relative calls versus one new candidate check.
- Actual coordinator tests cover parent-first/child-first order, alias differences, missing/present/unknown, unmatched paths, failure propagation and no fallback to another root.
- Standalone 10k-file benchmark: all identity/checksum comparisons passed. One warmup, three hot samples, fixed old/new order, index construction reported separately. No filesystem/DB fixture IO, end-to-end scan, peak RSS, p95, cold disk or Windows authorization claim.
- Prior useConflictReviewController.test.tsx remains +27/-0. No commit/push/release/user DB access. Full 15/42 plan remains incomplete.

Source patch is selected cumulative diff against base plus new files, depends on earlier batches, and is not a standalone incremental patch.

Final full: 2504 pass, 1 skip, 0 fail; build terminal exit0. All benchmark/focused/full/build terminal completions observed by parent.
