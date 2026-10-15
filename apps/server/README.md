# Javdex server

Independent Node host for the catalog database, plaintext image store, query worker, and LAN browse HTTP.

Use a version-matched desktop and Linux amd64/arm64 server release. The current source targets 0.9.0-beta.4 with catalog schema 21; source changes do not publish an image. See the [deployment guide](../../docs/SERVER_MODE.md), [managed updates](../../docs/SERVER_UPDATE.md), and [release readiness](../../docs/reviews/v0.9.0-readiness.md); a source version bump does not publish an image.

This process does **not** run Electron, Playwright, scrapers, or the plugin agent. Desktop keeps local mode. Management HTTP is registered by this host only (`/manage/v1`); the desktop LAN browse server must omit it.

## Run locally after build

```bash
npm run web:build
npm run server:build
npm run server:test
npm run server:smoke:node
```

`server:smoke` builds and runs the Linux container. `server:smoke:backup` verifies bidirectional backup/restore and desktop import using isolated containers and volumes. For backup smoke, first run `setup:desktop`, `desktop:build` and `server:build`, then `docker build -t javdex-server:backup-verification .` (or set `JAVDEX_BACKUP_SMOKE_IMAGE` to the image to test). Both checks exit non-zero when Docker is missing.

The host-process smoke exercises the private business runtime directly. It is not a supported public deployment entry. Use the managed container below for a public HTTPS address.

## Deploy

Use the version-matched [server config](../../deploy/javdex-server.example.json) and [Compose example](../../deploy/docker-compose.example.yml) linked from the release notes. Examples are repository files, not release attachments.

- SQLite and images live on the `/data` volume (local filesystem).
- `/program` is a separate persistent volume for business releases, the selected version, update credentials, and journal. An empty volume is seeded from the base image; recreating a container preserves a previously selected business release. The image tag alone does not identify the running business version.
- Media files are a separate mount from deploy config, not an admin UI path.
- Media-library source directories, including their contents and selected subdirectories, must be readable and writable by the business process. The official image uses a root manager supervising a non-root `node` business process; do not override the manager with Compose `user:`. Use a read/write media mount and grant the corresponding host/NAS filesystem permissions; a writable `/data` volume alone is insufficient. Adding a source writes a `.javdex-root` marker, even when only scanning or playback is intended. See [media directory permissions](../../docs/SERVER_MODE.md#媒体目录权限).
- Business UID/GID default to `1000:1000` and can be set with `JAVDEX_SERVER_UID` / `JAVDEX_SERVER_GID`. The supplementary-group fix adds `JAVDEX_SERVER_GROUPS` (comma-separated numeric GIDs, empty by default); startup and token commands explicitly apply these groups before executing business code. It requires a manager/base-image update, not just a business bundle; released Beta.4 images need the authorized group as the primary GID as a workaround. Compose `group_add` and successful `docker exec` reads do not prove the supervised business identity has access. Check its `/proc/<pid>/status` and reproduce with `setpriv`; see the public permissions reference for commands.
- `/live` and `/ready` do not return catalog data.
- Schema upgrade failure prevents listen/`ready`.
- SIGTERM stops HTTP, the query worker, and SQLite.

For the managed container, invoke the selected business CLI through the manager, not the image's initial `/app` seed:

```bash
docker compose -f docker-compose.example.yml exec javdex node /opt/javdex-manager/index.js token --config /config/server.json
```

Set `JAVDEX_PUBLIC_URL` to the client-visible HTTPS root address. Business, browse, playback, device pairing and updates share one public port (8096 by default); the business child listens only on private loopback 8098. Missing public URL or obsolete `JAVDEX_UPDATE_PUBLIC_URL` / `JAVDEX_UPDATE_PORT` / `JAVDEX_UPDATE_LISTEN_HOST` configuration fails startup. The only authorization command is `token`: copy its one-time token into the desktop manual connection form alongside the HTTPS address. First use saves the certificate automatically; valid public certificate renewal needs no confirmation, while a changed self-signed certificate requires consent. Existing devices remain valid. Reconfigure old dual-port deployments and authorize again while retaining data/program volumes. Keep the public entry on trusted local/private networks. The container needs no host-side updater or Docker socket.

## Upgrade

For important libraries, use a desktop matching the current server version to create a backup through Backup & Restore before upgrading. Save deployment configuration and desktop settings separately. An existing 0.8.0 deployment must first adopt the new base image and add `/program`; neither initial database migration nor later managed upgrades create automatic library backups. Keep the existing data volumes and Compose project identity; never run `docker compose down -v` to switch versions.

Already-managed deployments retain the selected business release when the base image is replaced. When the server version trails the desktop, use the recovery card to fetch that exact desktop version (including prerelease) or upload the version- and architecture-matched `Javdex-server-<version>-linux-<arch>.javdex-update`. The file contains the signed manifest and complete business archive; separate JSON/archive files are not accepted. Installation interrupts access, verifies the complete closure and native dependencies, without copying library data or existing backups. Installation failure or interruption keeps maintenance mode for manual recovery; only an unchanged service may resume before installation starts. Reject unknown signing roots, expired manifests, unsupported schemas, same-version installs, and downgrades.

Base-image replacement remains responsible for the manager, Node and system runtime; a business update cannot update those components. `npm run server:updater:test` covers host-process logic; `npm run server:updater:smoke` requires Linux Docker and verifies an isolated single-container update, failure maintenance and restart flow. Neither a documentation update nor an offline build is evidence that the final release artifacts passed these gates.

## Backup and recovery

Recover tokens are issued by the deploy CLI; HTTP `writer.recoverIssue` is loopback-only. `npm run server:smoke` is the Linux single-container check (requires Docker and a prior `server:build`); it claims a writer after `bind`. `server:smoke:node` is host-process only.

Use desktop Settings → Storage & Export → Backup & Restore after claiming writer access. Import keeps the source catalog independent and automatically backs up the target before replacement; original video files are not copied. Offline migration CLI/API and its dedicated package format have been removed. See [server operations](../../docs/SERVER_MODE.md) for the supported workflow.
