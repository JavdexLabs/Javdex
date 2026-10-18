'use strict';

// Real memfd -> addon -> Node Buffer ownership tests; no libmpv/GPU claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const native = process.env.CPU_NATIVE_DIR || path.join(process.cwd(), 'out/native-playback');
const bridge = require(path.join(native, 'playback-fd.node'));
const marker = Buffer.from('memfd transport fixture; not a DMA-BUF\n');
const fdCount = () => fs.readdirSync('/proc/self/fd').length;
async function fixture(mode, consume) {
  const { parentFd, childFd } = bridge.createChannel();
  const child = spawn(path.join(native, 'fd-transport-fixture'), [mode], { stdio: ['ignore', 'pipe', 'pipe', childFd] });
  bridge.close(childFd);
  child.stdout.resume(); child.stderr.resume();
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Fixture exited ${code}`)));
  });
  done.catch(() => {});
  try {
    const deadline = Date.now() + 5000;
    let frame;
    while (Date.now() < deadline && !(frame = bridge.receive(parentFd))) await delay(2);
    assert.ok(frame, 'Fixture must deliver an FD');
    consume(frame);
    await done;
  } finally { bridge.close(parentFd); child.kill(); }
}
async function main() {
  await fixture('cpu-sealed', (frame) => assert.deepEqual(bridge.copyFrame(frame.fd, marker.length), marker));
  const before = fdCount();
  for (let i = 0; i < 20; i++) {
    await fixture('cpu-sealed', (frame) => {
      const bytes = bridge.copyFrame(frame.fd, marker.length);
      assert.ok(Buffer.isBuffer(bytes)); assert.deepEqual(bytes, marker);
      assert.throws(() => fs.fstatSync(frame.fd), { code: 'EBADF' });
      assert.equal(bridge.close(frame.fd), false);
      assert.throws(() => bridge.copyFrame(frame.fd, marker.length), { code: 'ERR_FD_BRIDGE_OWNERSHIP' });
    });
  }
  for (const size of [0, -1, 1.5, NaN, Infinity, '37', 1280 * 720 * 4 + 1, marker.length - 1, marker.length + 1]) {
    await fixture('cpu-sealed', (frame) => {
      assert.throws(() => bridge.copyFrame(frame.fd, size));
      assert.throws(() => fs.fstatSync(frame.fd), { code: 'EBADF' });
      assert.equal(bridge.close(frame.fd), false);
    });
  }
  await fixture('send-only', (frame) => {
    assert.throws(() => bridge.copyFrame(frame.fd, marker.length), { code: 'ERR_FD_BRIDGE_FRAME' });
    assert.throws(() => fs.fstatSync(frame.fd), { code: 'EBADF' });
  });
  const channel = bridge.createChannel();
  for (const fd of [channel.parentFd, channel.childFd]) {
    assert.throws(() => bridge.copyFrame(fd, marker.length), { code: 'ERR_FD_BRIDGE_OWNERSHIP' });
    assert.doesNotThrow(() => fs.fstatSync(fd)); bridge.close(fd);
  }
  const unrelated = fs.openSync('/dev/null', 'r');
  assert.throws(() => bridge.copyFrame(unrelated, marker.length), { code: 'ERR_FD_BRIDGE_OWNERSHIP' });
  assert.doesNotThrow(() => fs.fstatSync(unrelated)); fs.closeSync(unrelated);
  await delay(10);
  assert.equal(fdCount(), before, 'copy success and rejection must never leak a descriptor');
  console.log('PASS: CPU memfd copy exact bytes, bounded extent/seals, consume-on-error, foreign FD rejection, and repeated FD cleanup');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
