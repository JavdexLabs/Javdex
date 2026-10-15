# Javdex server

Independent Node host for the catalog database, plaintext image store, query worker, and LAN browse HTTP.

This documentation targets the 0.9.0 stable release preparation. After the release is available, use `ghcr.io/javdexlabs/javdex-server:0.9.0` for Linux amd64 or arm64 and the matching 0.9.0 desktop. The catalog uses schema 20. See the [deployment guide](../../docs/SERVER_MODE.md), [managed updates](../../docs/SERVER_UPDATE.md), and [release readiness](../../docs/reviews/v0.9.0-readiness.md); a source version bump does not publish an image.

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

Use the version-matched [server config](../../deploy/javdex-server.example.json) and [Compose example](../../deploy/docker-compose.example.yml) linked from the release notes. Examples are repository files, not release attachments.

- SQLite and images live on the `/data` volume (local filesystem).
- `/program` is a separate persistent volume for business releases, the selected version, update credentials, journal, and pre-update snapshots. An empty volume is seeded from the base image; recreating a container preserves a previously selected business release. The image tag alone does not identify the running business version.
- Media files are a separate mount from deploy config, not an admin UI path.
- Media-library source directories, including their contents and selected subdirectories, must be readable and writable by the business process. The official image uses a root manager supervising a non-root `node` business process; do not override the manager with Compose `user:`. Use a read/write media mount and grant the corresponding host/NAS filesystem permissions; a writable `/data` volume alone is insufficient. Adding a source writes a `.javdex-root` marker, even when only scanning or playback is intended. See [media directory permissions](../../docs/SERVER_MODE.md#媒体目录权限).
- `/live` and `/ready` do not return catalog data.
- Schema upgrade failure prevents listen/`ready`.
- SIGTERM stops HTTP, the query worker, and SQLite.

For the managed container, invoke the selected business CLI through the manager, not the image's initial `/app` seed:

```bash
docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js bind --config /config/server.json
docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js recover --config /config/server.json
docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js pair --config /config/server.json
```

Business HTTP uses port 8096; the separately paired HTTPS update endpoint uses 8097. Keep both on trusted local/private networks. The container needs no host-side updater or Docker socket.

## Upgrade

Back up data, images, configuration and desktop settings before upgrading. An existing 0.8.0 deployment must first adopt the new base image and add `/program`; that initial database upgrade from schema 19 to 20 is not protected by a managed-update snapshot. Keep the existing data volumes and Compose project identity; never run `docker compose down -v` to switch versions.

Already-managed deployments retain the selected business release when the base image is replaced. Pair the desktop to check official stable releases or upload the architecture-matched `Javdex-server-<version>-linux-<arch>.javdex-update`. The file contains the signed manifest and complete business archive; separate JSON/archive files are not accepted. Installation interrupts access, verifies the complete closure and native dependencies, and restores the previous snapshot only before durable activation. Reject unknown signing roots, expired manifests, unsupported schemas, same-version installs, and downgrades.

Base-image replacement remains responsible for the manager, Node and system runtime; a business update cannot update those components. `npm run server:updater:test` covers host-process logic; `npm run server:updater:smoke` requires Linux Docker and verifies an isolated single-container update/recovery flow. Neither a documentation update nor an offline build is evidence that the final release artifacts passed these gates.

## Backup and recovery

Recover tokens are issued by the deploy CLI; HTTP `writer.recoverIssue` is loopback-only. `npm run server:smoke` is the Linux single-container check (requires Docker and a prior `server:build`); it claims a writer after `bind`. `server:smoke:node` is host-process only.

Use desktop Settings → Storage & Export → Backup & Restore after claiming writer access. Import keeps the source catalog independent and automatically backs up the target before replacement; original video files are not copied. Offline migration CLI/API and its dedicated package format have been removed. See [server operations](../../docs/SERVER_MODE.md) for the supported workflow.
