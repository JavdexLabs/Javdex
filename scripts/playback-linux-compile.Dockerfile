# Compile/N-API verification only, not a Linux GUI or redistributable runtime.
# Context must contain only native/ and the installed Electron electron-headers/.
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
    && readelf -h /output/playback.node
COPY scripts/ /source/scripts/
RUN node --test /source/scripts/playback-runtime.test.mjs \
    && node --input-type=module -e "import assert from 'node:assert/strict'; import {inspectLinuxPlaybackBinary} from '/source/scripts/playback-runtime.mjs'; assert.throws(()=>inspectLinuxPlaybackBinary('/output/playback.node',{directory:'/output',archName:process.arch,binaryFiles:new Set(['/output/playback.node'])}),/absent|non-local/); console.log('Development addon correctly rejected as a standalone release runtime.');"
CMD ["node", "-e", "const assert=require('node:assert/strict');const b=require('/output/playback.node');const bounds={x:0,y:0,width:1,height:1,scale:1};assert.equal(b.inspect().alive,false);assert.equal(b.state().alive,false);b.destroy();b.destroy();assert.throws(()=>b.create(Buffer.alloc(4),bounds,{backend:'wayland'}),/Wayland/);assert.throws(()=>b.create(Buffer.alloc(8),bounds,{backend:'x11'}),/uint32_t/);assert.throws(()=>b.create(Buffer.alloc(4),bounds,{backend:'x11'}),/Missing X11 parent/);const id=Buffer.alloc(4);id.writeUInt32LE(1);assert.throws(()=>b.create(id,bounds,{backend:'x11'}),/display/);assert.equal(b.inspect().alive,false);b.destroy();console.log('Linux addon load, explicit backend/handle checks and idempotent empty cleanup passed; no display, GL context, media or GUI was exercised.');"]
