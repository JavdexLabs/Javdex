# Shared contracts

Moved from `src/shared`. Existing `@shared/*` aliases remain during migration. This package contains existing IPC/domain types and pure helpers; it is not yet a complete remote API contract.

Production modules must remain browser-safe. Node filesystem/path identity helpers live in `packages/library`; Electron, SQLite, filesystem and server implementation imports are forbidden here. Avoid a barrel that eagerly pulls all contracts into either browser or server.

S01 split:

- Browser whitelist: `src/webTypes.ts`, `src/browser/dto.ts`
- Manage HTTP: `src/manage/*`
- Desktop session/capabilities: `src/desktop/*`
- Protocol envelope/errors/limits: `src/protocol/*`
- IPC disposition: `src/inventory/ipcDisposition.ts`

Desktop CatalogBackend ports live in `apps/desktop/src/main/application/` so the server never imports desktop ports. Per-use-case inventory: `docs/SERVER_MODE_CONTRACT_INVENTORY.md`.
