'use strict';

// Transport/ownership fixture only. A memfd is NOT a DMA-BUF, and these tests
// make no claim about EGL, importSharedTexture, libmpv, GPU fences, or Wayland.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const bridgePath = process.env.FD_BRIDGE_ADDON || path.join(__dirname, '../out/native-playback/playback-fd.node');
const fixturePath = process.env.FD_BRIDGE_FIXTURE || path.join(__dirname, '../out/native-playback/fd-transport-fixture');
const bridge = require(bridgePath);
const fdCount = () => fs.readdirSync('/proc/self/fd').length;

function start(mode) {
  const { parentFd, childFd } = bridge.createChannel();
  const child = spawn(fixturePath, [mode], {
    stdio: ['ignore', 'pipe', 'pipe', childFd],
  });
  // child_process installs its own inherited duplicate as child fd 3.
  assert.equal(bridge.close(childFd), true);
  let stdout = '', stderr = '';
  child.stdout.on('data', (part) => { stdout += part; });
  child.stderr.on('data', (part) => { stderr += part; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  // Avoid unhandled rejection if spawn fails before the polling loop sees EOF.
  done.catch(() => {});
  return { parentFd, child, done };
}

async function receive(fd) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const frame = bridge.receive(fd);
    if (frame !== null) return frame;
    await delay(5);
  }
  throw new Error('Timed out waiting for frame');
}

async function receiveReady(fd) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { bridge.unwatch(fd); reject(new Error('Readiness timeout')); }, 5000);
    bridge.watch(fd, 1, (status, events) => {
      try {
        assert.equal(status, 0);
        assert.ok(events & 1);
        const frame = bridge.receive(fd);
        if (!frame) return; // Readiness is a hint, not a guarantee.
        bridge.unwatch(fd);
        clearTimeout(timeout);
        resolve(frame);
      } catch (error) { bridge.unwatch(fd); clearTimeout(timeout); reject(error); }
    });
  });
}

async function assertChild(done) {
  const result = await done;
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  return result;
}

async function main() {
  // Warm the same piped-child path before counting. libuv may lazily open its
  // reserve /dev/null descriptor when the first pipe handle is created.
  const warm = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
  warm.stdout.resume();
  warm.stderr.resume();
  await new Promise((resolve, reject) => { warm.once('error', reject); warm.once('close', resolve); });

  const before = fdCount();
  const idle = bridge.createChannel();
  assert.equal(bridge.receive(idle.parentFd), null);
  let acceptedAcks = 0;
  while (acceptedAcks < 100000 && bridge.sendAck(idle.parentFd, 0)) acceptedAcks++;
  assert.ok(acceptedAcks > 0 && acceptedAcks < 100000, 'ACK send has nonblocking backpressure');
  assert.equal(bridge.close(idle.childFd), true);
  assert.throws(() => bridge.receive(idle.parentFd), { code: 'ERR_FD_BRIDGE_CLOSED' });
  // MSG_NOSIGNAL means a dead peer becomes an exception, never process death.
  assert.throws(() => bridge.sendAck(idle.parentFd, 1), { code: 'ERR_FD_BRIDGE_IO' });
  assert.equal(bridge.close(idle.parentFd), true);
  assert.equal(bridge.close(idle.parentFd), false);
  assert.throws(() => bridge.receive(idle.parentFd), { code: 'ERR_FD_BRIDGE_OWNERSHIP' });

  // Idle readable watches do not wake; writable interest can be removed inside
  // the callback without leaving a permanent always-writable busy loop.
  const watched = bridge.createChannel();
  let wakes = 0;
  bridge.watch(watched.parentFd, 1, () => { wakes++; });
  assert.throws(() => bridge.watch(watched.parentFd, 1, () => {}), { code: 'ERR_FD_BRIDGE_WATCH' });
  for (const value of [-1, 4, 0.5, NaN, '1']) {
    assert.throws(() => bridge.updateWatch(watched.parentFd, value), { code: 'ERR_FD_BRIDGE_WATCH' });
  }
  await delay(30);
  assert.equal(wakes, 0);
  bridge.unwatch(watched.parentFd);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Writable readiness timeout')), 1000);
    bridge.watch(watched.parentFd, 2, (status, events) => {
      assert.equal(status, 0); assert.ok(events & 2); wakes++;
      bridge.updateWatch(watched.parentFd, 0);
      clearTimeout(timeout); resolve();
    });
  });
  await delay(30);
  assert.equal(wakes, 1, 'Disabled writable watcher must not spin');
  bridge.close(watched.parentFd); bridge.close(watched.childFd);
  // Immediate FD reuse occurs before deferred uv_close callbacks. A stopped
  // watcher must never notify the replacement channel or close its descriptor.
  const replacement = bridge.createChannel();
  bridge.watch(replacement.parentFd, 1, () => { wakes++; });
  await delay(30);
  assert.equal(wakes, 1);
  assert.equal(bridge.receive(replacement.parentFd), null);
  bridge.close(replacement.parentFd); bridge.close(replacement.childFd);
  await delay(10);

  const pressure = bridge.createChannel();
  while (bridge.sendAck(pressure.parentFd, 0)) {}
  let writableWakes = 0;
  bridge.watch(pressure.parentFd, 2, () => { writableWakes++; });
  await delay(30);
  assert.equal(writableWakes, 0, 'Full send queue is not writable');
  bridge.unwatch(pressure.parentFd);
  const drained = spawn(fixturePath, ['drain-acks'], { stdio: ['ignore', 'ignore', 'pipe', pressure.childFd] });
  const drainedDone = new Promise((resolve, reject) => {
    drained.once('error', reject); drained.once('close', code => code === 0 ? resolve() : reject(new Error(`Drain exited ${code}`)));
  });
  drained.stderr.resume();
  bridge.close(pressure.childFd);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No writable wake after peer drain')), 5000);
    bridge.watch(pressure.parentFd, 2, (status, events) => {
      assert.equal(status, 0); assert.ok(events & 2);
      if (!bridge.sendAck(pressure.parentFd, 1)) return;
      bridge.unwatch(pressure.parentFd);
      clearTimeout(timeout); resolve();
    });
  });
  await drainedDone;
  bridge.close(pressure.parentFd);
  await delay(10);

  const unrelated = fs.openSync('/dev/null', 'r');
  assert.equal(bridge.close(unrelated), false);
  assert.doesNotThrow(() => fs.fstatSync(unrelated));
  fs.closeSync(unrelated);

  const valid = start('valid');
  const frame = await receiveReady(valid.parentFd);
  assert.ok(Buffer.isBuffer(frame.metadata));
  const metadata = JSON.parse(frame.metadata.toString('utf8'));
  assert.equal(metadata.isDmaBuf, false);
  assert.equal(metadata.sequence, '18446744073709551615');
  const content = Buffer.alloc(128);
  const length = fs.readSync(frame.fd, content, 0, content.length, 0);
  assert.equal(content.subarray(0, length).toString(), 'memfd transport fixture; not a DMA-BUF\n');
  const fdInfo = fs.readFileSync(`/proc/self/fdinfo/${frame.fd}`, 'utf8');
  const flags = Number.parseInt(fdInfo.match(/^flags:\s+(\d+)$/m)[1], 8);
  assert.ok((flags & 0o2000000) !== 0, 'SCM_RIGHTS FD has close-on-exec');
  for (const invalid of [-1n, 1n << 64n, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => bridge.sendAck(valid.parentFd, invalid), { code: 'ERR_FD_BRIDGE_SEQUENCE' });
  }
  assert.equal(bridge.close(frame.fd), true);
  assert.throws(() => fs.fstatSync(frame.fd), { code: 'EBADF' });
  assert.equal(bridge.sendAck(valid.parentFd, BigInt(metadata.sequence)), true);
  const accepted = await assertChild(valid.done);
  assert.match(accepted.stdout, /ACK verified/);
  bridge.close(valid.parentFd);

  for (const mode of ['missing', 'empty-fd', 'extra', 'ctrunc', 'trunc', 'both-trunc']) {
    const fixture = start(mode);
    await assert.rejects(receive(fixture.parentFd), { code: 'ERR_FD_BRIDGE_PACKET' });
    await assertChild(fixture.done);
    bridge.close(fixture.parentFd);
    assert.equal(fdCount(), before, `No descriptor leak after ${mode}`);
  }
  const eof = start('eof');
  await assert.rejects(receive(eof.parentFd), { code: 'ERR_FD_BRIDGE_CLOSED' });
  await assertChild(eof.done);
  bridge.close(eof.parentFd);

  // Bounded async copies. A started read is not cancelled: close waits until the
  // worker finishes, and a fourth read is rejected while three are still queued.
  const sealedJobs = [start('sealed'), start('sealed'), start('sealed'), start('sealed')];
  const sealedFrames = [];
  for (const job of sealedJobs) sealedFrames.push(await receiveReady(job.parentFd));
  const reads = sealedFrames.slice(0, 3).map((frame) => bridge.readPixelsAsync(frame.fd, 4096));
  assert.throws(() => bridge.readPixels(sealedFrames[0].fd, 4096), { code: 'ERR_CPU_FRAME' });
  assert.throws(() => bridge.readPixelsAsync(sealedFrames[3].fd, 4096), { code: 'ERR_CPU_FRAME' });
  assert.equal(bridge.close(sealedFrames[0].fd), true);
  assert.doesNotThrow(() => fs.fstatSync(sealedFrames[0].fd));
  const copied = await Promise.all(reads);
  for (const pixels of copied) {
    assert.equal(pixels.length, 4096);
    assert.ok(pixels.every((byte) => byte === 0xA5));
  }
  assert.throws(() => fs.fstatSync(sealedFrames[0].fd), { code: 'EBADF' });
  assert.equal(bridge.readPixels(sealedFrames[3].fd, 4096)[0], 0xA5);
  for (const frame of sealedFrames.slice(1)) assert.equal(bridge.close(frame.fd), true);
  for (const job of sealedJobs) {
    assert.equal(bridge.sendAck(job.parentFd, 1), true);
    await assertChild(job.done);
    bridge.close(job.parentFd);
  }
  assert.equal(fdCount(), before, 'No descriptor leak after bounded async reads');

  // A worker's environment teardown must release addon-owned descriptors even
  // when its JS deliberately omits close(). Workers share the process FD table.
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(`
    const bridge = require(${JSON.stringify(bridgePath)});
    const a = bridge.createChannel(), b = bridge.createChannel();
    bridge.watch(a.parentFd, 1, () => {});
    bridge.watch(b.parentFd, 1, () => {});
    bridge.unwatch(b.parentFd); // Teardown includes an already-closing watch.
  `, { eval: true });
  await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
  await delay(10);
  assert.equal(fdCount(), before, 'No descriptor leak after complete lifecycle and worker teardown');
  console.log('PASS: real SCM_RIGHTS memfd transfer, uint64 ACK, CLOEXEC, strict packet validation, SIGPIPE safety, ownership, malformed-packet FD cleanup, and worker teardown');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
