# Javdex server

Independent Node host for the catalog database, plaintext image store, query worker, and LAN browse HTTP.

This process does **not** run Electron, Playwright, scrapers, or the plugin agent. Desktop keeps local mode. Management HTTP is registered by this host only (`/manage/v1`); the desktop LAN browse server must omit it.

## Run locally after build

```bash
npm run web:build
npm run server:build
npm run server:test
npm run server:smoke:node
```

`server:smoke` builds and runs the Linux container. It exits non-zero when Docker is missing.

```bash
node out/server/index.js start --config deploy/javdex-server.example.json
node out/server/index.js bind --config deploy/javdex-server.example.json
node out/server/index.js recover --config deploy/javdex-server.example.json
```

Set `JAVDEX_WEB_PASSWORD` to a 12–128 character browse password. Catalog browse stays unavailable until a writer claims an `initialBind` one-time token. `bind` and `recover` print the plaintext token once to stdout; only the hash is stored. Optional `JAVDEX_BOOTSTRAP_TOKEN` is used as the first unbound bind token and ignored after the instance is bound.

## Deploy

See `deploy/javdex-server.example.json` and `deploy/docker-compose.example.yml`.

- SQLite and images live on the `/data` volume (local filesystem).
- Media files are a separate mount from deploy config, not an admin UI path.
- `/live` and `/ready` do not return catalog data.
- Schema upgrade failure prevents listen/`ready`.
- SIGTERM stops HTTP, the query worker, and SQLite.

## Not in this stage

Recover tokens are issued by the deploy CLI; HTTP `writer.recoverIssue` is loopback-only. `npm run server:smoke` is the Linux container check (requires Docker and a prior `server:build`); it claims a writer after `bind`. `server:smoke:node` is host-process only.
