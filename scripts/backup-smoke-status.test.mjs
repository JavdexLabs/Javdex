import assert from 'node:assert/strict'
import test from 'node:test'
import { readBackupSmokeResponse, waitForBackupPhase } from './backup-smoke-status.mjs'

const gatewayUnavailable = () => new Response('服务暂不可用，更新入口仍可访问', { status: 503 })
const completed = () => Response.json({ jobs: [{ phase: 'completed' }] })
function replay(responses) {
  const requests = [], sleeps = []
  const post = async (operation, input) => {
    requests.push({ operation, input })
    const next = responses.shift()
    assert.ok(next, 'unexpected retry')
    if (next instanceof Error) throw next
    return readBackupSmokeResponse(next)
  }
  return { requests, sleeps, wait: () => waitForBackupPhase(post, 'fixture-job', 'completed', async ms => { sleeps.push(ms) }) }
}

test('reads a completed durable backup job without retry', async () => {
  const state = replay([completed()])
  assert.equal((await state.wait()).phase, 'completed')
  assert.equal(state.requests.length, 1)
  assert.deepEqual(state.sleeps, [])
})
test('waits across the captured gateway gap using only status reads', async () => {
  const state = replay([gatewayUnavailable(), completed()])
  assert.equal((await state.wait()).phase, 'completed')
  assert.deepEqual(state.requests, Array.from({ length: 2 }, () => ({
    operation: 'backup.control', input: { action: 'status', id: 'fixture-job' }
  })))
  assert.deepEqual(state.sleeps, [100])
})
test('a permanent gateway outage still fails at the original polling bound', async () => {
  const state = replay(Array.from({ length: 200 }, gatewayUnavailable))
  await assert.rejects(state.wait(), /timeout: completed/)
  assert.equal(state.requests.length, 200)
  assert.equal(state.sleeps.length, 200)
})
test('keeps the existing transport interruption retry limited to status reads', async () => {
  const state = replay([new TypeError('socket closed during restore'), completed()])
  await state.wait()
  assert.equal(state.requests.length, 2)
  assert.deepEqual(state.sleeps, [100])
})
for (const [name, response] of [
  ['unauthorized', () => new Response('not authorized', { status: 401 })],
  ['identity mismatch', () => Response.json({ code: 'INSTANCE_MISMATCH' }, { status: 409 })],
  ['unknown 503 text', () => new Response('unknown upstream failure', { status: 503 })],
  ['unknown 503 JSON', () => Response.json({ code: 'UNKNOWN_ERROR' }, { status: 503 })],
  ['other status with the gateway body', () => new Response('服务暂不可用，更新入口仍可访问', { status: 502 })],
  ['malformed successful JSON', () => new Response('not JSON', { status: 200 })]
]) test(`${name} fails immediately instead of hiding the response`, async () => {
  const state = replay([response(), completed()])
  await assert.rejects(state.wait())
  assert.equal(state.requests.length, 1)
  assert.deepEqual(state.sleeps, [])
})
test('certificate and unknown errors are not treated as a restore gap', async () => {
  for (const error of [new Error('certificate changed'), new Error('unknown failure')]) {
    const state = replay([error, completed()])
    await assert.rejects(state.wait(), value => value === error)
    assert.equal(state.requests.length, 1)
  }
})
test('failed and recovery-required jobs remain failures', async () => {
  for (const phase of ['failed', 'recoveryRequired']) {
    const state = replay([Response.json({ jobs: [{ phase, error: 'manual recovery required' }] }), completed()])
    await assert.rejects(state.wait(), /manual recovery required/)
    assert.equal(state.requests.length, 1)
  }
})
test('malformed status objects fail without being retried as transport errors', async () => {
  for (const value of [null, {}, { jobs: [] }, { jobs: [{}] }]) {
    const state = replay([Response.json(value), completed()])
    await assert.rejects(state.wait(), /invalid backup status response/)
    assert.equal(state.requests.length, 1)
    assert.deepEqual(state.sleeps, [])
  }
})
test('a restore command receiving 503 is rejected and is never replayed', async () => {
  await assert.rejects(readBackupSmokeResponse(gatewayUnavailable()))
})
test('ordinary pending jobs keep the existing polling interval and bound', async () => {
  const state = replay(Array.from({ length: 200 }, () => Response.json({ jobs: [{ phase: 'restoring' }] })))
  await assert.rejects(state.wait(), /timeout: completed/)
  assert.equal(state.requests.length, 200)
  assert.deepEqual(new Set(state.sleeps), new Set([50]))
})
