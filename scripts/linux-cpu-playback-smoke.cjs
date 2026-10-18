#!/usr/bin/env node
'use strict';
// Real libmpv software-render + SCM_RIGHTS acceptance. This is NOT a Canvas,
// visible-window or audible-speaker test; those require separate GUI evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const directory = path.resolve(process.env.CPU_SMOKE_OUTPUT || 'out/cpu-playback-acceptance');
const sample = path.resolve(process.argv[2] || path.join(directory, 'cpu-720p30-h264-aac.mp4'));
const helper = path.resolve(process.env.CPU_PLAYBACK_HELPER || 'out/native-playback/playback-cpu-helper');
const addon = path.resolve(process.env.FD_BRIDGE_ADDON || 'out/native-playback/playback-fd.node');
const bridge = require(addon);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fdCount = () => fs.readdirSync('/proc/self/fd').length;
const ticksPerSecond = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
const quick = process.argv.includes('--quick');
function encode(fields) {
  const buffers = fields.map(value => Buffer.from(String(value)));
  const size = 4 + buffers.reduce((sum, value) => sum + 4 + value.length, 0);
  const data = Buffer.alloc(size + 4); data.writeUInt32LE(size); data.writeUInt32LE(fields.length, 4);
  let offset = 8;
  for (const value of buffers) { data.writeUInt32LE(value.length, offset); offset += 4; value.copy(data, offset); offset += value.length; }
  return data;
}
function usage(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return { cpuSeconds: (Number(stat[11]) + Number(stat[12])) / ticksPerSecond,
      rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024,
      fds: fs.readdirSync(`/proc/${pid}/fd`).length };
  } catch { return null; }
}
function start() {
  const channel = bridge.createChannel();
  const child = spawn(helper, ['--stdio-v1'], { stdio: ['pipe', 'pipe', 'pipe', channel.childFd] });
  bridge.close(channel.childFd);
  const session = { child, fd: channel.parentFd, state: {}, frames: 0, discarded: 0, generation: 1,
    lastSequence: 0, latest: null, input: '', error: null, hold: false, leases: new Map(),
    hashes: new Set(), maxOutstanding: 0, maxRss: 0, maxFds: 0, bytes: 0, copyingMs: 0, lastUsage: 0, closed: false };
  session.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  session.done.catch(() => {});
  child.stdin.on('error', error => { if (!session.closed) session.error ??= error; });
  child.stdout.setEncoding('utf8');
  child.stderr.resume(); // libmpv output may contain locators; never persist it.
  child.stdout.on('data', data => {
    session.input += data;
    let end;
    while ((end = session.input.indexOf('\n')) >= 0) {
      const line = session.input.slice(0, end); session.input = session.input.slice(end + 1);
      try { session.state = JSON.parse(line); if (session.state.error) session.error = new Error(session.state.error); }
      catch (error) { session.error = error; }
    }
  });
  session.send = (...fields) => child.stdin.write(encode(fields));
  session.release = () => {
    for (const sequence of session.leases.keys()) {
      if (!bridge.sendAck(session.fd, sequence)) break;
      session.leases.delete(sequence);
    }
  };
  session.timer = setInterval(() => {
    try {
      for (let count = 0; count < 3; count++) {
        const packet = bridge.receive(session.fd);
        if (!packet) break;
        const frame = JSON.parse(packet.metadata.toString('utf8'));
        assert.equal(frame.protocol, 'javdex-cpu-frame-v1'); assert.equal(frame.pixelFormat, 'rgba');
        assert.ok(Number.isSafeInteger(frame.sequence) && frame.sequence > session.lastSequence);
        assert.ok(frame.slot >= 0 && frame.slot < 3 && ![...session.leases.values()].includes(frame.slot));
        assert.ok(frame.width > 0 && frame.width <= 1280 && frame.height > 0 && frame.height <= 720);
        assert.equal(frame.stride, frame.width * 4); assert.equal(frame.size, frame.stride * frame.height);
        assert.ok(frame.generation > 0 && frame.generation <= session.generation); assert.equal(frame.producerComplete, true);
        const begin = performance.now(), pixels = bridge.copyFrame(packet.fd, frame.size);
        session.copyingMs += performance.now() - begin;
        assert.equal(pixels.length, frame.size);
        session.lastSequence = frame.sequence; session.leases.set(frame.sequence, frame.slot);
        session.maxOutstanding = Math.max(session.maxOutstanding, session.leases.size);
        if (frame.generation !== session.generation) session.discarded++;
        else {
          session.frames++; session.bytes += pixels.length;
          const hash = digest(pixels); session.hashes.add(hash);
          session.latest = { ...frame, pixels, hash };
        }
        if (!session.hold) session.release();
      }
      const current = Date.now() - session.lastUsage > 200 ? usage(child.pid) : null;
      if (current) session.lastUsage = Date.now();
      if (current) { session.maxRss = Math.max(session.maxRss, current.rssBytes); session.maxFds = Math.max(session.maxFds, current.fds); }
    } catch (error) { if (!session.closed) session.error ??= error; }
  }, 4);
  session.seek = position => { session.send('generation', ++session.generation); session.send('command', 'seek', position, 'absolute+exact'); };
  session.load = () => { session.send('generation', ++session.generation); session.send('command', 'loadfile', sample); };
  session.close = async () => {
    session.closed = true; clearInterval(session.timer);
    child.stdin.end(encode(['destroy']));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    const result = await session.done; clearTimeout(timeout); bridge.close(session.fd);
    assert.equal(result.signal, null); assert.equal(result.code, 0, (session.error?.message || '') + JSON.stringify(session.state));
  };
  return session;
}
async function until(session, predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (session.error) throw session.error;
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out: ${message}; state=${JSON.stringify(session.state)}`);
}
async function settle(session, milliseconds) { await delay(milliseconds); if (session.error) throw session.error; }
function corners(frame) {
  const read = (x, y) => [...frame.pixels.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4)];
  const result = { topLeft: read(25, 25), topRight: read(frame.width - 25, 25), bottomLeft: read(25, frame.height - 25), bottomRight: read(frame.width - 25, frame.height - 25) };
  const { topLeft: r, topRight: g, bottomLeft: b, bottomRight: y } = result;
  assert.ok(r[0] > 180 && r[1] < 70 && r[2] < 70, 'red is top left');
  assert.ok(g[1] > 180 && g[0] < 70 && g[2] < 70, 'green is top right');
  assert.ok(b[2] > 180 && b[0] < 70 && b[1] < 70, 'blue is bottom left');
  assert.ok(y[0] > 180 && y[1] > 180 && y[2] < 70, 'yellow is bottom right');
  assert.ok(Object.values(result).every(value => value[3] === 255), 'opaque RGBA');
  return result;
}
async function main() {
  assert.ok(fs.existsSync(sample)); fs.mkdirSync(directory, { recursive: true });
  // Warm libuv's reserve descriptor before measuring leak-free reopen.
  await new Promise(resolve => { const child = spawn(process.execPath, ['-e', '']); child.on('close', resolve); });
  const baselineFds = fdCount(), session = start(), started = Date.now();
  const evidence = { scope: 'Real H.264/AAC file decoded by independent libmpv SW renderer, memfd/SCM_RIGHTS and Node binary copy. No visible GUI or audible output claim.',
    sample: { fileName: path.basename(sample), sha256: digest(fs.readFileSync(sample)) },
    helperSha256: digest(fs.readFileSync(helper)), addonSha256: digest(fs.readFileSync(addon)),
    hasDrmDirectory: fs.existsSync('/dev/dri'), node: process.version, quick, checks: {} };
  try {
    session.send('create', '0', '0', '0', '1280', '720', '1', 'cpu');
    // A real mpv null AO runs the AAC decoder and audio clock without requiring
    // host speakers. PCM/audible output is a separate acceptance stage.
    session.send('command', 'set', 'options/ao', 'null');
    session.load(); session.send('visible', '1'); session.send('command', 'set', 'pause', 'no');
    await until(session, () => session.frames >= 20 && session.state.loadedFiles >= 1, 'real decoded frames');
    evidence.checks.colorsAndOrientation = corners(session.latest);
    const raw = path.join(directory, 'decoded-first-frame.rgba'); fs.writeFileSync(raw, session.latest.pixels);
    const png = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '1280x720', '-i', raw, '-frames:v', '1', path.join(directory, 'decoded-first-frame.png')], { encoding: 'utf8' });
    assert.equal(png.status, 0, png.stderr); fs.unlinkSync(raw);
    if (!quick) await settle(session, 3000);
    const mark = { frames: session.frames, bytes: session.bytes, time: Date.now(), cpu: usage(session.child.pid).cpuSeconds };
    await settle(session, quick ? 1000 : 15000);
    const seconds = (Date.now() - mark.time) / 1000;
    evidence.measurement = { scope: 'Instrumented native consumer including hashing; excludes Electron IPC/Canvas and physical display', seconds, frames: session.frames - mark.frames, receivedFps: (session.frames - mark.frames) / seconds,
      binaryBytesPerSecond: (session.bytes - mark.bytes) / seconds,
      helperCpuPercentOneCore: (usage(session.child.pid).cpuSeconds - mark.cpu) / seconds * 100 };
    evidence.checks.realMotionDistinctHashes = session.hashes.size; assert.ok(session.hashes.size > 10);
    evidence.checks.audio = { codec: session.state['audio-codec'], output: session.state['current-ao'], pts: session.state['audio-pts'], audible: 'not tested; null AO' };
    assert.ok(session.state['audio-codec']); assert.ok(session.state['audio-pts'] > 0);
    session.send('command', 'set', 'pause', 'yes'); await until(session, () => session.state.pause === true, 'pause'); await settle(session, 500);
    const paused = { frames: session.frames, position: session.state['time-pos'], hash: session.latest.hash };
    const pauseMs = quick ? 500 : 30000; await settle(session, pauseMs);
    assert.ok(session.frames - paused.frames <= 2); assert.ok(Math.abs(session.state['time-pos'] - paused.position) < 0.1);
    evidence.checks.pause = { milliseconds: pauseMs, extraFrames: session.frames - paused.frames, positionStable: true };
    session.send('command', 'set', 'sid', 'no'); await until(session, () => session.state.sid === 'no', 'disable subtitle'); await settle(session, 300);
    const withoutSubtitle = session.latest.hash;
    session.send('command', 'set', 'sid', '1'); await until(session, () => session.state.sid === '1' && session.latest.hash !== withoutSubtitle, 'embedded subtitle changes paused pixels');
    evidence.checks.embeddedSubtitlePixels = 'changed on same paused video frame';
    session.send('command', 'set', 'sid', 'no');
    await until(session, () => session.state.sid === 'no' && session.latest.hash === withoutSubtitle, 'remove embedded subtitle');
    const generated = '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nStyle: Default,Microsoft YaHei,42,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1\n[Events]\nDialogue: 0,0:00:00.00,0:01:00.00,Default,,0,0,0,,CPU GENERATED OVERLAY\n';
    session.send('generated-subtitles', 'update', generated, '1', '1');
    await until(session, () => session.state.generatedSubtitleRevision === 1 && session.latest.hash !== withoutSubtitle, 'generated overlay changes paused pixels');
    session.send('generated-subtitles', 'visible', '', '0', '2');
    await until(session, () => session.state.generatedSubtitleRevision === 2 && session.latest.hash === withoutSubtitle, 'remove generated overlay');
    evidence.checks.generatedSubtitlePixels = 'overlay changed paused pixels and removal restored exact baseline';
    for (const position of [15, 3, 25]) {
      session.seek(position); await until(session, () => session.latest.generation === session.generation && Math.abs(session.state['time-pos'] - position) < 0.2, `seek ${position}`);
    }
    evidence.checks.seek = { targets: [15, 3, 25], generation: session.generation };
    session.send('bounds', '0', '0', '640', '360', '1'); await until(session, () => session.latest.width === 640 && session.latest.height === 360, 'smaller viewport');
    session.send('bounds', '0', '0', '1920', '1080', '1'); await until(session, () => session.latest.width === 1280 && session.latest.height === 720, '720p output cap');
    evidence.checks.resizeAndCap = '640x360 then 1920x1080 viewport capped at1280x720';
    session.send('command', 'set', 'pause', 'no'); session.hold = true;
    await until(session, () => session.leases.size === 3, 'three-slot backpressure');
    const heldSequence = session.lastSequence; await settle(session, 500); assert.equal(session.lastSequence, heldSequence);
    session.send('visible', '0'); const hiddenMs = quick ? 500 : 10000; await settle(session, hiddenMs);
    assert.equal(session.lastSequence, heldSequence); session.hold = false; session.release();
    session.send('visible', '1'); await until(session, () => session.lastSequence > heldSequence, 'show after held-slot hide');
    evidence.checks.backpressureAndHidden = { maximumOutstanding: session.maxOutstanding, hiddenMilliseconds: hiddenMs, reusedBeforeRelease: false, resumed: true };
    evidence.state = Object.fromEntries(['backend', 'hwdec-current', 'video-codec', 'audio-codec', 'current-ao', 'nativeFrames', 'exportedFrames', 'cpuFramesInFlight', 'cpuDroppedFrames', 'commandErrors', 'subtitleCommandErrors', 'loadedFiles'].filter(key => key in session.state).map(key => [key, session.state[key]]));
    assert.equal(session.state.commandErrors, 0); assert.equal(session.state.subtitleCommandErrors, 0);
    evidence.resources = { maxHelperRssBytes: session.maxRss, maxHelperFds: session.maxFds,
      fixedPixelPoolBytes: 3 * 1280 * 720 * 4, nodeCopyTimeMs: session.copyingMs, frames: session.frames, elapsedSeconds: (Date.now() - started) / 1000 };
  } finally { await session.close(); }
  const reopen = start();
  try {
    reopen.send('create', '0', '0', '0', '1280', '720', '1', 'cpu');
    reopen.send('command', 'set', 'options/ao', 'null'); reopen.load(); reopen.send('visible', '1'); reopen.send('command', 'set', 'pause', 'no');
    await until(reopen, () => reopen.frames >= 5, 'reopen real decoder');
  } finally { await reopen.close(); }
  const pcm = start(), wave = path.join(directory, 'decoded-aac.wav');
  try {
    pcm.send('create', '0', '0', '0', '1280', '720', '1', 'cpu');
    pcm.send('command', 'set', 'ao', 'pcm'); pcm.send('command', 'set', 'ao-pcm-file', wave);
    pcm.load(); pcm.send('visible', '1'); pcm.send('command', 'set', 'pause', 'no');
    await until(pcm, () => pcm.state['current-ao'] === 'pcm' && pcm.frames >= 5, 'real AAC decode to PCM');
    await settle(pcm, 300);
    evidence.checks.pcmAudio = { codec: pcm.state['audio-codec'], output: pcm.state['current-ao'], audible: false };
  } finally { await pcm.close(); }
  const pcmBytes = spawnSync('ffmpeg', ['-v', 'error', '-i', wave, '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(pcmBytes.status, 0, pcmBytes.stderr.toString());
  assert.ok(pcmBytes.stdout.length > 48000 * 4 / 10, 'At least100ms of actual audio samples');
  let energy = 0, peak = 0;
  for (let offset = 0; offset < pcmBytes.stdout.length; offset += 4) {
    const value = pcmBytes.stdout.readFloatLE(offset); assert.ok(Number.isFinite(value)); energy += value * value; peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(energy / (pcmBytes.stdout.length / 4)); assert.ok(rms > 0.001 && peak > 0.01, 'Decoded audio is non-silent');
  Object.assign(evidence.checks.pcmAudio, { waveBytes: fs.statSync(wave).size, sha256: digest(fs.readFileSync(wave)), monoFloatSamples: pcmBytes.stdout.length / 4, rms, peak });
  await delay(100); assert.equal(fdCount(), baselineFds);
  evidence.checks.reopenAndCleanup = { reopened: true, fdBaseline: baselineFds, fdAfter: fdCount() };
  evidence.status = 'passed';
  fs.writeFileSync(path.join(directory, quick ? 'cpu-smoke-quick.json' : 'cpu-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
