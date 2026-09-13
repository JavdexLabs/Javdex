# Desktop workspace

Electron main/preload/renderer and desktop MCP source live under `src/`.

From the repository root: `npm run dev`, `npm run build`, `npm run typecheck`, `npm test`.
Workspace equivalents: `npm run dev -w @javdex/desktop`, `npm run build -w @javdex/desktop`.

The root remains the Electron packaging application and owns `out/`, release metadata and the transitional production dependency manifest. Desktop workspace scripts deliberately execute from the repository root. Do not change the process cwd or move `out/` without updating runtime asset/worker and packaging checks.

LAN browser HTTP, pairing/auth storage, browse DTO projection and static serving live in `packages/http`. `src/main/web/webAccess.ts` remains the Electron lifecycle adapter. Extract remaining desktop-only assembly according to [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md).
