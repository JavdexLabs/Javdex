#!/usr/bin/env bash
# Research only: run in a disposable node:22-bookworm container with /source read-only.
set -euo pipefail
mkdir -p /probe
cd /probe
cp -a /source/apps /source/packages /source/scripts /probe/
printf '{"private":true}\n' > package.json
if [ -d /dependencies/node_modules ]; then
  # Optional host-fetched Linux/glibc packages; never copy desktop node_modules.
  cp -a /dependencies/. /probe/
else
  npm install --no-audit --no-fund --save-exact better-sqlite3@13.0.3 sharp@0.35.4 tsx@4.22.4
fi
node --no-experimental-strip-types --require tsx/cjs --require ./scripts/register-test-paths.cjs ./scripts/research/server-mode-docker-probe.cts
node --no-experimental-strip-types --require tsx/cjs --require ./scripts/register-test-paths.cjs --test packages/library/src/db/migrationsV16.test.ts
