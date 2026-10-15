FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/JavdexLabs/Javdex" \
      org.opencontainers.image.description="Javdex self-hosted library server" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

ARG NPM_CONFIG_REGISTRY

WORKDIR /app

COPY out/server/package.json ./package.json
COPY out/server/index.js out/server/webCatalogWorker.js ./
COPY out/server/web ./web
COPY out/server/LICENSE out/server/NOTICE ./
COPY out/server/LICENSES ./LICENSES
COPY out/server/docs ./docs
COPY out/server/closure.json ./closure.json

RUN npm install --omit=dev --no-audit --no-fund \
  && apt-get update && apt-get install -y --no-install-recommends tini openssl util-linux ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /media \
  && chown -R node:node /app /data
COPY out/server/build-info.json ./build-info.json
COPY out/updater /opt/javdex-manager
RUN node /opt/javdex-manager/package.mjs metadata /app \
  && mkdir -p /program && chown -R root:root /app /opt/javdex-manager /program \
  && chmod 755 /app /opt/javdex-manager /program

EXPOSE 8096
VOLUME ["/data", "/media", "/program"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/javdex-manager/index.js"]
CMD ["start"]
