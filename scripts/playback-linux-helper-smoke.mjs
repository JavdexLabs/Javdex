// No-display protocol/load smoke only; this does not create GL or play media.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

if (process.platform !== 'linux') throw new Error('Linux playback helper smoke requires Linux')
const executable = process.argv[2]
assert.ok(executable, 'Pass the built playback-helper executable')
const environment = { ...process.env }
delete environment.DISPLAY
delete environment.WAYLAND_DISPLAY
function message(fields) {
  const values = fields.map(value => Buffer.from(value, 'utf8'))
  const payload = 4 + values.reduce((sum, value) => sum + 4 + value.length, 0)
  const result = Buffer.alloc(payload + 4)
  result.writeUInt32LE(payload, 0); result.writeUInt32LE(fields.length, 4)
  let offset = 8
  for (const value of values) { result.writeUInt32LE(value.length, offset); offset += 4; value.copy(result, offset); offset += value.length }
  return result
}
function run(input, expectedStatus, args = ['--stdio-v1']) {
  const result = spawnSync(path.resolve(executable), args, { input, env: environment, encoding: 'utf8',
    timeout: 10000, maxBuffer: 1024 * 1024, shell: false })
  if (result.error) throw result.error
  assert.equal(result.signal, null, 'helper must not crash or require forced termination')
  assert.equal(result.status, expectedStatus, result.stderr)
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
run(Buffer.alloc(0), 2, [])
run(Buffer.alloc(0), 0)
run(message(['destroy']), 0)
for (const fields of [
  ['create', '1', '0', '0', '1', '1', '1', 'wayland'],
  ['create', '0', '0', '0', '1', '1', '1', 'x11'],
  ['create', '4294967296', '0', '0', '1', '1', '1', 'x11'],
  ['create', '1', '0', '0', '1', '1', '1', 'x11']
]) {
  const states = run(message(fields), 1)
  assert.ok(states.some(state => state.alive === false && state.errorKind === 'native' && typeof state.error === 'string'))
}
const oversized = Buffer.alloc(4); oversized.writeUInt32LE(1024 * 1024 + 1)
assert.ok(run(oversized, 1).some(state => state.alive === false && state.errorKind === 'native'))
console.log('Linux helper load, private protocol, EOF/destroy and no-display failures passed; no GL, media, GUI or audio was exercised.')
