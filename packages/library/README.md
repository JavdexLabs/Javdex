# Shared library backend — extraction in progress

`src/` contains Node-only local path, root identity and source-resource identity helpers, the catalog SQLite layer under `src/db`, scan helpers and orchestration under `src/scan`, image storage (`mediaAssetStore` and asset path/crypto helpers), public-image HTTP under `src/net`, catalog application services under `src/catalog`, and a minimal `src/runtime` host port. `@library/*` resolves here.

Electron cover export and window guards remain under `apps/desktop/src/main`. Scanner orchestration, scan-audit read, automatic scan scheduling, classification query/maintenance/images, actress query/conflict/gallery/maintenance, tag queries, playlist and media-library maintenance, video maintenance/lifecycle, asset migration, pending resource identity, NFO tickets/workset, maintenance gate, path cleanup, public-image fetch, and image storage live here and stay Node-only. Local NFO apply is a host port (`scan/nfoScanPort.ts`); the desktop scrape-backed implementation stays in desktop. Scrape proxy URLs are injected through `LibraryHost.http`, not read from desktop settings. Video scraper plugin checks are injected by the desktop media-library factory, not imported into production library. This package must not depend on Electron, Playwright, desktop modules, or the reserved `http`/`server` workspaces.

`getDb()` remains a process-local connection opened by `initDatabaseAtPath` in this slice. The desktop entry calls `configureDesktopLibraryRuntime()` before opening the catalog. S02D will inject the connection through `CatalogBackend`; do not treat the current singleton as the final host assembly.

See [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md).
