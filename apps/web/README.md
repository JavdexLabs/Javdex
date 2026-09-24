# Browser workspace

Read-only browser source lives in `src/`. Run `npm run build -w @javdex/web` from the repository root; output remains `out/web` and is embedded in desktop/server distributions.

Do not import desktop main/preload/renderer, library storage or HTTP server implementation. Shared browser-safe contracts and Checkbox live in `packages/contracts` and `packages/ui`. This workspace does not introduce a separately deployed web server.
