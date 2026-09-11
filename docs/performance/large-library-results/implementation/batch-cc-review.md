# CC acceptance

Missing/NULL audit body in optional views mode is now represented explicitly by auditAvailable=false. Same construction transaction validates current summary identity before copying persistent unrecognized paths into existing bounded TEMP structures. Raw section reads still fail; malformed/invalid/oversized body never falls back. Existing private handles retain their read snapshot; worker revision detects subsequent writes and rebuilds. Header/page are separate requests, not atomic.

Two independent read-only reviews found no concrete blocker in scope, readonly/transaction handling, budgets, missing-versus-corrupt behavior and source restoration. Source byte cap still covers audit JSON only; unrecognized copy remains subject to TEMP/page quotas. UI has not switched yet and must derive a view request from the checked summary when header.snapshot is null, show body availability and refresh header on stale-summary error.

58 focused tests pass. New cases: 150 unique unrecognized paths across pages plus duplicate semantics/anchor/badge/raw rejection/private snapshot/new summary rejection; malformed/mismatched/oversized bodies do not silently fall back; real worker205 paths, header without snapshot, summary supersession, recovery after raw failure and body restoration. Initial worker fixture omitted required scan_run_id then its FK run; corrected fixture by inserting a run with NULL body, keeping constraints intact.

Selected cumulative patch depends on CA/CB and prior batches, not an independent sequential patch. No new benchmark or browser evidence, persistent schema change, user DB/media access, commit/push/release. Full15/42 goal remains incomplete.

Final gates: npm test2432pass1skip0fail; npm run build terminal0. Original AP/AQ controller regression remains +27/-0 versus HEAD.
