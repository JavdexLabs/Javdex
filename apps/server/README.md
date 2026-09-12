# Javdex server

Independent Node host for the catalog database, plaintext image store, query worker, and LAN browse HTTP.

This process does **not** assemble management HTTP, run Electron, Playwright, scrapers, or the plugin agent. Desktop keeps local mode; remote desktop access is a later stage.

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
```

Set `JAVDEX_WEB_PASSWORD` to a 12–128 character browse password. Catalog browse stays unavailable until `bind` writes the occupancy marker under the data directory.

## Deploy

See `deploy/javdex-server.example.json` and `deploy/docker-compose.example.yml`.

- SQLite and images live on the `/data` volume (local filesystem).
- Media files are a separate mount from deploy config, not an admin UI path.
- `/live` and `/ready` do not return catalog data.
- Schema upgrade failure prevents listen/`ready`.
- SIGTERM stops HTTP, the query worker, and SQLite.

## Not in this stage

Writer identity, takeover, image upload protocol, RemoteCatalogBackend, and management routes are later stages. The bind file is only an occupancy gate for browse; it is not a writer token or recovery password.
