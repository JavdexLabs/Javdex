# HTTP adapter

Runtime-neutral LAN browser HTTP lives here: request helpers, pairing/session storage, browse catalog projection, Range/static serving, and `WebServer`.

Optional `manage` dispatch is registered only by the independent server host. Desktop LAN browse omits it so `/manage/v1` stays 404. Browser session cookies are never treated as writer credentials.

Desktop `webAccess` still owns Electron lifecycle, `userData` session files, and local-mode assembly. It injects listen address and access hosts separately and never enables the management HTTP surface.

HTTP may import contracts, `packages/library` public modules, and Node builtins. It must not import Electron, desktop settings, Playwright, or `apps/server`.

See [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md).
