# Shared library backend — extraction in progress

`src/` contains Node-only local path, root identity and source-resource identity helpers, the catalog SQLite layer under `src/db`, scan helpers under `src/scan`, image storage (`mediaAssetStore` and asset path/crypto helpers), and a minimal `src/runtime` host port. `@library/*` resolves here.

Scanner orchestration, NFO import/export, and catalog application services remain under `apps/desktop/src/main` until later S02 slices. Image storage talks to the desktop host for paths, encryption, and decode. This package must not depend on Electron, Playwright, desktop modules, or the reserved `http`/`server` workspaces.

`getDb()` remains a process-local connection opened by `initDatabaseAtPath` in this slice. The desktop entry calls `configureDesktopLibraryRuntime()` before opening the catalog. S02D will inject the connection through `CatalogBackend`; do not treat the current singleton as the final host assembly.

See [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md).
