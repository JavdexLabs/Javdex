# HTTP adapter — reserved, not extracted

Extract the runtime-neutral HTTP server, browser authorization/DTO projection and management routes here in S03. Existing implementation remains under `apps/desktop/src/main/web` and still imports desktop dependencies.

HTTP depends on contracts and explicit library services. It must not depend on desktop settings, Electron or the server executable entry point. Desktop local mode assembles only the permitted local browser surface; server mode assembles browser and separately authorized management surfaces.

See [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md).
