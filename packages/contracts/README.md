# Shared contracts

Moved from `src/shared`. Existing `@shared/*` aliases remain during migration. This package contains existing IPC/domain types and pure helpers; it is not yet a complete remote API contract.

Production modules must remain browser-safe. Node filesystem/path identity helpers live in `packages/library`; Electron, SQLite, filesystem and server implementation imports are forbidden here. Split browser and management remote DTOs explicitly during S01. Avoid a barrel that eagerly pulls all contracts into either browser or server.
