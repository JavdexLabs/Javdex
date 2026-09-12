# Server workspace — reserved, not implemented

This workspace reserves the independent Node entry point, lifecycle, deployment configuration and Docker build. There is intentionally no placeholder server or successful no-op build script.

The first server build must use real SQLite, image storage, query workers and HTTP without Electron/Playwright. Implement stages S02–S04 in [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md). Do not import the desktop application entry point or copy desktop `node_modules` into the image.
