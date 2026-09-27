# Javdex server

Independent Node host for the catalog database, plaintext image store, query worker, and LAN browse HTTP.

The 0.8.0 release image is `ghcr.io/javdexlabs/javdex-server:0.8.0` for Linux amd64 and arm64. Use the matching 0.8.0 desktop release; see the [deployment guide](../../docs/SERVER_MODE.md) for Compose setup and upgrades.

This process does **not** run Electron, Playwright, scrapers, or the plugin agent. Desktop keeps local mode. Management HTTP is registered by this host only (`/manage/v1`); the desktop LAN browse server must omit it.

## Run locally after build

```bash
npm run web:build
npm run server:build
npm run server:test
npm run server:smoke:node
```

`server:smoke` builds and runs the Linux container. `server:smoke:backup` verifies bidirectional backup/restore and desktop import using isolated containers and volumes. For backup smoke, first run `setup:desktop`, `desktop:build` and `server:build`, then `docker build -t javdex-server:backup-verification .` (or set `JAVDEX_BACKUP_SMOKE_IMAGE` to the image to test). Both checks exit non-zero when Docker is missing.

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
- Media-library source directories, including their contents and selected subdirectories, must be readable and writable by the server process (the official image runs as `node`). Use a read/write media mount and grant the corresponding host/NAS filesystem permissions; a writable `/data` volume alone is insufficient. Adding a source writes a `.javdex-root` marker, even when only scanning or playback is intended. See [media directory permissions](../../docs/SERVER_MODE.md#媒体目录权限).
- `/live` and `/ready` do not return catalog data.
- Schema upgrade failure prevents listen/`ready`.
- SIGTERM stops HTTP, the query worker, and SQLite.

## Backup and recovery

Recover tokens are issued by the deploy CLI; HTTP `writer.recoverIssue` is loopback-only. `npm run server:smoke` is the Linux single-container check (requires Docker and a prior `server:build`); it claims a writer after `bind`. `server:smoke:node` is host-process only.

Use desktop Settings → Storage & Export → Backup & Restore after claiming writer access. Import keeps the source catalog independent and automatically backs up the target before replacement; original video files are not copied. Offline migration CLI/API and its dedicated package format have been removed. See [server operations](../../docs/SERVER_MODE.md) for the supported workflow.
