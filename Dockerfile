FROM node:22-bookworm-slim

WORKDIR /app

COPY out/server/package.json ./package.json
COPY out/server/index.js out/server/webCatalogWorker.js ./
COPY out/server/web ./web

RUN npm install --omit=dev --no-audit --no-fund \
  && mkdir -p /data /media \
  && chown -R node:node /app /data

USER node
EXPOSE 8096
VOLUME ["/data", "/media"]
ENTRYPOINT ["node", "index.js"]
CMD ["start"]
