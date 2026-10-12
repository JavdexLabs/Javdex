# Compile/helper-protocol verification only, not a Linux GUI or redistributable runtime.
# Context contains native/, installed electron-headers/, and documented scripts/ only.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake make g++ pkg-config libmpv-dev libx11-dev libgl-dev libglx-dev libopengl-dev libxft-dev \
    && rm -rf /var/lib/apt/lists/*
COPY native/ /source/native/
COPY electron-headers/ /source/electron-headers/
RUN cmake -S /source/native -B /build -DCMAKE_BUILD_TYPE=Release \
    -DELECTRON_INCLUDE_DIR=/source/electron-headers -DMPV_PREFIX=/usr -DPLAYBACK_OUTPUT_DIR=/output \
    && cmake --build /build --parallel 2 \
    && /output/mpv-core-test && /output/x11-controls-test
RUN dpkg-query -W libmpv-dev libglx-dev libx11-dev libxft-dev && node --version \
    && readelf -h /output/playback-helper
COPY scripts/ /source/scripts/
RUN node --test /source/scripts/playback-runtime.test.mjs \
    && node --input-type=module -e "import assert from 'node:assert/strict'; import {inspectLinuxPlaybackBinary} from '/source/scripts/playback-runtime.mjs'; assert.throws(()=>inspectLinuxPlaybackBinary('/output/playback-helper',{directory:'/output',archName:process.arch,binaryFiles:new Set(['/output/playback-helper'])}),/absent|non-local/); console.log('Development helper correctly rejected as a standalone release runtime.');"
CMD ["node", "/source/scripts/playback-linux-helper-smoke.mjs", "/output/playback-helper"]
