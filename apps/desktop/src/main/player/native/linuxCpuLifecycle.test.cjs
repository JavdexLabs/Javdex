'use strict';

// Real libmpv regression for generation provenance under overlapping commands.
// Invoke from repository root with the generated acceptance sample path.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const native = process.env.CPU_NATIVE_DIR || path.join(process.cwd(), 'out/native-playback');
const bridge = require(path.join(native, 'playback-fd.node'));
const sample = path.resolve(process.argv[2] || 'out/cpu-playback-acceptance/cpu-720p30-h264-aac.mp4');
function encode(fields) {
  const values = fields.map(value => Buffer.from(String(value)));
  const length = 4 + values.reduce((sum, value) => sum + 4 + value.length, 0);
  const bytes = Buffer.alloc(length + 4); bytes.writeUInt32LE(length); bytes.writeUInt32LE(values.length, 4);
  let offset = 8;
  for (const value of values) { bytes.writeUInt32LE(value.length, offset); offset += 4; value.copy(bytes, offset); offset += value.length; }
  return bytes;
}
async function main() {
  const channel = bridge.createChannel();
  const child = spawn(path.join(native, 'playback-cpu-helper'), ['--stdio-v1'], { stdio: ['pipe', 'pipe', 'pipe', channel.childFd] });
  bridge.close(channel.childFd);
  let generation = 1, latest, input = '', state = {}, failure, closing = false, frames = 0;
  const hashes = new Map();
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  child.stderr.resume(); child.stdin.on('error', error => { if (!closing) failure = error; });
  child.stdout.on('data', data => {
    input += data;
    let end;
    while ((end = input.indexOf('\n')) >= 0) {
      state = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      if (state.error) failure = new Error(state.error);
    }
  });
  const send = (...fields) => child.stdin.write(encode(fields));
  const timeline = (...command) => { send('generation', ++generation); send('command', ...command); latest = undefined; };
  const timer = setInterval(() => {
    try {
      for (let i = 0; i < 3; i++) {
        const packet = bridge.receive(channel.parentFd); if (!packet) break;
        const meta = JSON.parse(packet.metadata.toString());
        const pixels = bridge.copyFrame(packet.fd, meta.size);
        assert.equal(bridge.sendAck(channel.parentFd, meta.sequence), true);
        const hash = createHash('sha256').update(pixels).digest('hex');
        if (!hashes.has(meta.generation)) hashes.set(meta.generation, new Set());
        hashes.get(meta.generation).add(hash); frames++;
        if (meta.generation === generation) latest = { ...meta, hash };
      }
    } catch (error) { if (!closing) failure = error; }
  }, 2);
  async function until(predicate) {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (failure) throw failure; if (predicate()) return; await delay(5); }
    throw new Error(`Timed out generation ${generation}, state=${JSON.stringify(state)}`);
  }
  try {
    send('create', 0, 0, 0, 1280, 720, 1, 'cpu');
    send('command', 'set', 'ao', 'null'); send('command', 'set', 'sid', 'no');
    send('visible', 1); timeline('loadfile', sample);
    await until(() => latest && state['pause']); await delay(100);
    const firstHash = latest.hash;
    timeline('seek', 25, 'absolute+exact'); await until(() => latest); await delay(50);
    const targetHash = latest.hash;
    assert.notEqual(targetHash, firstHash, 'Sample must distinguish target times');
    for (let burst = 0; burst < 12; burst++) {
      for (const target of [3, 15, 7, 22, 1, 9, 25]) {
        timeline('seek', target, 'absolute+exact');
        if (burst % 2) await delay(2);
      }
      await until(() => latest);
      assert.equal(latest.hash, targetHash, `Final rapid-seek generation ${generation} must contain target25 pixels`);
      assert.deepEqual([...hashes.get(generation)], [targetHash], 'No stale pixels may be tagged with the final generation');
    }
    for (let burst = 0; burst < 6; burst++) {
      for (let i = 0; i < 5; i++) { timeline('loadfile', sample); if (burst % 2) await delay(2); }
      await until(() => latest);
      assert.equal(latest.hash, firstHash, 'Final consecutive-load generation must contain first-frame pixels');
      assert.deepEqual([...hashes.get(generation)], [firstHash]);
    }
    assert.equal(state.commandErrors, 0);
    console.log(JSON.stringify({ status: 'passed', rapidPausedSeeks: 84, consecutiveLoadReplacements: 30,
      generations: generation, frames, checks: 'Every final-generation pixel hash matches the separately established target frame; no stale generation promotion.' }));
  } finally {
    closing = true; clearInterval(timer); child.stdin.end(encode(['destroy']));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    const result = await done; clearTimeout(timeout); bridge.close(channel.parentFd);
    assert.deepEqual(result, { code: 0, signal: null });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
