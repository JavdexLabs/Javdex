# Shared library backend — extraction in progress

`src/` contains Node-only local path, root identity and source-resource identity helpers, the catalog SQLite layer under `src/db`, scan helpers and orchestration under `src/scan`, image storage (`mediaAssetStore` and asset path/crypto helpers), and a minimal `src/runtime` host port. `@library/*` resolves here.

Electron cover export, window guards, and remaining video maintenance / remote-image import services remain under `apps/desktop/src/main` until later S02 slices. Scanner orchestration, scan-audit read, classification query/maintenance, actress query/conflict, tag queries, playlist maintenance, NFO tickets/workset, maintenance gate, path cleanup, and image storage live here and stay Node-only. Local NFO apply is a host port (`scan/nfoScanPort.ts`); the desktop scrape-backed implementation stays in desktop. This package must not depend on Electron, Playwright, desktop modules, or the reserved `http`/`server` workspaces.

`getDb()` remains a process-local connection opened by `initDatabaseAtPath` in this slice. The desktop entry calls `configureDesktopLibraryRuntime()` before opening the catalog. S02D will inject the connection through `CatalogBackend`; do not treat the current singleton as the final host assembly.

See [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md).
