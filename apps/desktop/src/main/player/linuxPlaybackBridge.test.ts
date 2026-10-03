import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { createLinuxPlaybackBridge, encodePlaybackMessage } from './linuxPlaybackBridge'

const LIMIT = 1024 * 1024
const bounds = { x: 11, y: 22, width: 333, height: 222, scale: 1.5 }
const linuxOnly = { skip: process.platform !== 'linux' ? 'real executable helper fixtures require Linux' : false }
const handle = (): Buffer => { const value = Buffer.alloc(4); value.writeUInt32LE(123); return value }
function decode(frame: Buffer): string[] {
  assert.equal(frame.readUInt32LE(0), frame.length - 4)
  const count = frame.readUInt32LE(4), fields: string[] = []
  let offset = 8
  for (let index = 0; index < count; index++) {
    const length = frame.readUInt32LE(offset); offset += 4
    fields.push(frame.subarray(offset, offset + length).toString('utf8')); offset += length
  }
  assert.equal(offset, frame.length)
  return fields
}
async function until<T>(read: () => T, done: (value: T) => boolean, reason: string, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout
  while (true) {
    const value = read()
    if (done(value)) return value
    assert.ok(Date.now() < deadline, reason)
    await delay(10)
  }
}
interface Entry { pid: number; fields: string[] }
function fixture(t: TestContext, mode = 'normal') {
  const root = mkdtempSync(path.join(tmpdir(), 'javdex-helper-bridge-'))
  const directory = path.join(root, 'helper spaces 字幕'); mkdirSync(directory)
  const executable = path.join(directory, 'fixture helper.cjs'), log = path.join(root, 'messages.jsonl')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const log = ${JSON.stringify(log)}, mode = ${JSON.stringify(mode)};
const record = fields => fs.appendFileSync(log, JSON.stringify({ pid: process.pid, fields }) + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
record(['startup', ...process.argv.slice(2)]);
if (process.argv[2] !== '--stdio-v1') process.exit(2);
let input = Buffer.alloc(0), hanging = false;
function dispatch(fields) {
  record(fields);
  if (fields[0] === 'create') {
    const bytes = Buffer.from(JSON.stringify({ alive: true, loadedFiles: process.pid, duration: 120, 'track-list': '字幕🎬' }) + '\\n');
    const split = bytes.indexOf(Buffer.from('字幕')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
  } else if (fields[0] === 'destroy') {
    if (hanging) return;
    const stop = () => { emit({ alive: false, loadedFiles: 999999 }); process.exit(0); };
    if (mode === 'slow-destroy') setTimeout(stop, 80); else stop();
  } else if (fields[0] === 'command') {
    switch (fields[1]) {
      case 'actions':
        process.stdout.write(JSON.stringify({ alive: true, loadedFiles: process.pid, 'time-pos': 10, actions: [{ kind: 'toggle-pause' }] }) + '\\n'
          + JSON.stringify({ alive: true, loadedFiles: process.pid, 'time-pos': 11, actions: [{ kind: 'seek-relative', value: 5 }] }) + '\\n'); break;
      case 'invalid-json': process.stdout.write('not json\\n'); break;
      case 'invalid-state': emit({ alive: 'yes' }); break;
      case 'invalid-actions': emit({ alive: true, actions: 'toggle-pause' }); break;
      case 'invalid-action-item': emit({ alive: true, actions: [null] }); break;
      case 'invalid-action-kind': emit({ alive: true, actions: [{ kind: 'shell' }] }); break;
      case 'invalid-action-value': emit({ alive: true, actions: [{ kind: 'seek-relative', value: 'five' }] }); break;
      case 'too-many-actions': emit({ alive: true, actions: Array.from({ length: 33 }, () => ({ kind: 'toggle-pause' })) }); break;
      case 'action-overflow': process.stdout.write(Array.from({ length: 5 }, () => JSON.stringify({ alive: true, actions: Array.from({ length: 32 }, () => ({ kind: 'toggle-pause' })) }) + '\\n').join('')); break;
      case 'oversize': process.stdout.write('x'.repeat(1024 * 1024 + 1)); break;
      case 'exit': process.exit(23); break;
      case 'close-input': process.stdin.once('close', () => { try { fs.closeSync(0); } catch {} emit({ alive: true, volume: 71 }); }); process.stdin.destroy(); setInterval(() => {}, 1000); break;
      case 'hang': hanging = true; process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); break;
      default: emit({ alive: true, loadedFiles: process.pid, volume: 43 });
    }
  }
}
process.stdin.on('data', data => {
  input = Buffer.concat([input, data]);
  while (input.length >= 4 && input.length >= input.readUInt32LE(0) + 4) {
    const length = input.readUInt32LE(0), frame = input.subarray(0, length + 4), fields = [];
    let offset = 8;
    for (let index = 0; index < frame.readUInt32LE(4); index++) {
      const size = frame.readUInt32LE(offset); offset += 4;
      fields.push(frame.subarray(offset, offset + size).toString('utf8')); offset += size;
    }
    if (offset !== frame.length) process.exit(3);
    input = input.subarray(length + 4); dispatch(fields);
  }
});
process.stdin.on('end', () => { if (!hanging && mode !== 'slow-destroy') process.exit(0); });
process.stdin.on('error', () => {});
`)
  chmodSync(executable, 0o755)
  const bridge = createLinuxPlaybackBridge(executable)
  const entries = (): Entry[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Entry) : []
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  t.after(async () => {
    bridge.destroy()
    const pids = [...new Set(entries().map(entry => entry.pid))]
    try { await until(() => pids.some(alive), running => !running, 'fixture helper did not terminate') }
    finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })
  const start = async (): Promise<number> => {
    bridge.create(handle(), bounds, { backend: 'x11' })
    const state = await until(() => bridge.state(), state => state['track-list'] === '字幕🎬', 'fixture did not acknowledge create')
    assert.ok(state.loadedFiles)
    return state.loadedFiles
  }
  return { bridge, entries, start, alive, executable }
}
async function failure(bridge: ReturnType<typeof createLinuxPlaybackBridge>): Promise<Error> {
  const error = await until(() => {
    try { bridge.state(); return null } catch (error) { return error instanceof Error ? error : new Error(String(error)) }
  }, value => value !== null, 'bridge did not report helper failure')
  assert.ok(error)
  return error
}

test('Linux protocol uses byte lengths and preserves special UTF-8 locators without shell interpretation', () => {
  const fields = ['command', 'loadfile', '/媒体 folder/字幕🎬;$(touch ignored)\n"quote"\\file.mkv', 'replace', '']
  assert.deepEqual(decode(encodePlaybackMessage(fields)), fields)
  assert.deepEqual(decode(encodePlaybackMessage(Array(16).fill(''))), Array(16).fill(''))
  assert.throws(() => encodePlaybackMessage([]), /无效/)
  assert.throws(() => encodePlaybackMessage(Array(17).fill('')), /无效/)
  assert.throws(() => encodePlaybackMessage(['command', 'nul\0byte']), /无效/)
  assert.equal(encodePlaybackMessage(['x'.repeat(LIMIT - 8)]).length, LIMIT + 4)
  assert.throws(() => encodePlaybackMessage(['x'.repeat(LIMIT - 7)]), /过长/)
  assert.throws(() => encodePlaybackMessage(['字'.repeat(Math.ceil((LIMIT - 8) / 3))]), /过长/)
})

test('Linux bridge validates backend and XID before starting a helper', linuxOnly, t => {
  const f = fixture(t)
  assert.throws(() => f.bridge.create(handle(), bounds), /显式/)
  for (const size of [0, 1, 3, 5, 16]) assert.throws(() => f.bridge.create(Buffer.alloc(size), bounds, { backend: 'x11' }), /显式/)
  assert.throws(() => f.bridge.create(Buffer.alloc(4), bounds, { backend: 'x11' }), /无效/)
  const overflow = Buffer.alloc(8); overflow.writeBigUInt64LE(0x100000000n)
  assert.throws(() => f.bridge.create(overflow, bounds, { backend: 'x11' }), /无效/)
  assert.deepEqual(f.entries(), [])
})

test('Linux bridge exchanges real pipe messages, caches state, drains actions and coalesces viewport updates', linuxOnly, async t => {
  const f = fixture(t), pid = await f.start()
  assert.deepEqual(f.entries().slice(0, 2), [
    { pid, fields: ['startup', '--stdio-v1'] },
    { pid, fields: ['create', '123', '11', '22', '333', '222', '1.5', 'x11'] }
  ])
  const locator = '/媒体 folder/a;$(touch ignored)\n"subtitle".mkv'
  f.bridge.command(['loadfile', locator, 'replace'])
  f.bridge.setBounds(bounds); f.bridge.setBounds(bounds)
  f.bridge.setVisible(true); f.bridge.setVisible(true)
  f.bridge.setPresentation('fullscreen'); f.bridge.setPresentation('fullscreen')
  await until(f.entries, entries => entries.some(entry => entry.fields[0] === 'presentation'), 'viewport messages did not arrive')
  assert.deepEqual(f.entries().find(entry => entry.fields[0] === 'command')?.fields, ['command', 'loadfile', locator, 'replace'])
  for (const kind of ['bounds', 'visible', 'presentation']) assert.equal(f.entries().filter(entry => entry.fields[0] === kind).length, 1)
  f.bridge.command(['actions'])
  const state = await until(() => f.bridge.state(), value => value['time-pos'] === 11, 'actions did not arrive')
  assert.deepEqual(state.actions, [{ kind: 'toggle-pause' }, { kind: 'seek-relative', value: 5 }])
  assert.deepEqual(f.bridge.state().actions, [])
  assert.equal(f.bridge.state()['time-pos'], 11)
  f.bridge.render()
  f.bridge.destroy(); f.bridge.destroy()
  assert.equal(f.bridge.state().alive, false)
  await until(() => f.alive(pid), running => !running, 'destroy did not stop fixture')
  assert.equal(f.entries().filter(entry => entry.fields[0] === 'destroy').length, 1)
})

test('Linux bridge ignores late output and exit from an old helper during reopen', linuxOnly, async t => {
  const f = fixture(t, 'slow-destroy'), first = await f.start(), second = await f.start()
  assert.notEqual(first, second)
  await until(() => f.alive(first), running => !running, 'old helper did not finish delayed destroy')
  assert.equal(f.bridge.state().alive, true)
  assert.equal(f.bridge.state().loadedFiles, second)
  f.bridge.setBounds(bounds); f.bridge.setVisible(true); f.bridge.setPresentation('fullscreen')
  await until(f.entries, entries => entries.some(entry => entry.pid === second && entry.fields[0] === 'presentation'), 'new helper did not receive viewport')
})

test('Linux helper failure is controlled and a subsequent create clears it', linuxOnly, async t => {
  const f = fixture(t)
  await f.start(); f.bridge.command(['exit'])
  assert.match((await failure(f.bridge)).message, /已退出.*23/)
  assert.throws(() => f.bridge.render(), /已退出/)
  await f.start()
  assert.equal(f.bridge.state().alive, true)
})

for (const command of ['invalid-json', 'invalid-state', 'invalid-actions', 'invalid-action-item', 'invalid-action-kind', 'invalid-action-value', 'too-many-actions', 'action-overflow', 'oversize']) {
  test('Linux bridge rejects malformed helper output: ' + command, linuxOnly, async t => {
    const f = fixture(t), pid = await f.start()
    f.bridge.command([command])
    assert.match((await failure(f.bridge)).message, /状态无效|状态过长/)
    await until(() => f.alive(pid), running => !running, 'failed helper was not stopped')
  })
}

test('Linux bridge reports spawn errors without an uncaught error event', linuxOnly, async t => {
  const f = fixture(t)
  rmSync(f.executable)
  f.bridge.create(handle(), bounds, { backend: 'x11' })
  assert.match((await failure(f.bridge)).message, /无法启动/)
  f.bridge.destroy()
  assert.equal(f.bridge.state().alive, false)
})

test('Linux bridge handles a broken input pipe without crashing the host process', linuxOnly, async t => {
  const f = fixture(t)
  await f.start(); f.bridge.command(['close-input'])
  await until(() => f.bridge.state(), value => value.volume === 71, 'fixture did not close its input')
  f.bridge.command(['set', 'volume', '25'])
  assert.match((await failure(f.bridge)).message, /控制通道断开/)
})

test('Linux bridge bounds shutdown of a helper that ignores destroy and EOF', linuxOnly, async t => {
  const f = fixture(t), pid = await f.start()
  f.bridge.command(['hang'])
  await until(f.entries, entries => entries.some(entry => entry.fields[1] === 'hang'), 'fixture did not enter unresponsive mode')
  f.bridge.destroy()
  assert.equal(f.bridge.state().alive, false)
  await until(() => f.alive(pid), running => !running, 'unresponsive fixture survived bounded shutdown')
})
