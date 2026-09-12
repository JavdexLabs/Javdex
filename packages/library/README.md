# Shared library backend — extraction in progress

`src/` contains Node-only local path, root identity and source-resource identity helpers, the catalog SQLite layer under `src/db`, and the scan helpers that layer currently requires (`src/scan`). `@library/*` resolves here.

Scanner orchestration, NFO import/export, catalog application services and image storage remain under `apps/desktop/src/main` until later S02 slices. This package must not depend on Electron, Playwright, desktop modules, or the reserved `http`/`server` workspaces. Inject settings, paths, storage and runtime policy; preserve the different local/server root and encryption policies. A directory rename is not a substitute for removing import-time desktop singletons.

`getDb()` remains a process-local connection opened by `initDatabaseAtPath` in this slice. S02D will inject the connection through `CatalogBackend`; do not treat the current singleton as the final host assembly.

See [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md).
