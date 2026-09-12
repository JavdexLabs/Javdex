# Shared library backend — extraction started

`src/` currently contains the existing Node-only local path, root identity and source-resource identity helpers plus their existing resource-identity test. `@library/*` resolves here.

Database/schema, domain services, scan/NFO and transactional image coordination remain under `apps/desktop/src/main` until S02. This package must not depend on Electron or desktop modules. Inject settings, paths, storage and runtime policy; preserve the different local/server root and encryption policies. A directory rename is not a substitute for removing import-time desktop singletons.

See [the execution plan](../../docs/SERVER_MODE_EXECUTION_PLAN.md).
