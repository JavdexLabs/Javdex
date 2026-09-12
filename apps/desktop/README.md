# Desktop workspace

Electron main/preload/renderer and desktop MCP source live under `src/`.

From the repository root: `npm run dev`, `npm run build`, `npm run typecheck`, `npm test`.
Workspace equivalents: `npm run dev -w @javdex/desktop`, `npm run build -w @javdex/desktop`.

The root remains the Electron packaging application and owns `out/`, release metadata and the transitional production dependency manifest. Desktop workspace scripts deliberately execute from the repository root. Do not change the process cwd or move `out/` without updating runtime asset/worker and packaging checks.

`src/main/db`, domain services, scanners, NFO and `src/main/web` still contain legacy desktop assembly. Extract runtime-neutral implementations into `packages/library` and `packages/http` according to [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md); moving source has not made those modules server-safe.
