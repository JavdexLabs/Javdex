# Headless local inference only; no server, user data, display or GPU acceptance.
FROM node:22-bookworm-slim AS node
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates xz-utils libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /work
ENTRYPOINT ["node", "/work/platform-smoke.cjs"]
