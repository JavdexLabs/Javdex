import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createModelValidation } from './modelValidation'

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await delay(5) }
  assert.fail('validation did not settle')
}

test('checks each exact variant serially and retains independent CPU/GPU evidence', async () => {
  let active = 0
  const calls: string[] = []
  const checks = createModelValidation({ debounceMs: 1, available: () => true, changed() {},
    targets: () => [{ variant: 'speech' }, { variant: 'text' }],
    validate: async ref => {
      assert.equal(active++, 0); calls.push(ref.variant); await delay(5); active--
      return ref.variant === 'speech' ? { backend: 'cuda', device: 'RTX 4080' } : { backend: 'cpu', reason: '加速运行库未就绪' }
    } })
  try {
    checks.invalidate(); await until(() => checks.get('text')?.state === 'passed')
    assert.equal(checks.get('speech')?.execution?.backend, 'cuda')
    assert.equal(checks.get('text')?.execution?.backend, 'cpu')
    checks.schedule(); await delay(20)
    assert.deepEqual(calls, ['speech', 'text'])
  } finally { await checks.close() }
})

test('a configuration invalidation discards a late success from the previous generation', async () => {
  let calls = 0, complete: (() => void) | undefined
  const checks = createModelValidation({ debounceMs: 1, available: () => true, changed() {}, targets: () => [{ variant: 'model' }],
    validate: async () => {
      if (++calls === 1) { await new Promise<void>(resolve => { complete = resolve }); return { backend: 'cuda' } }
      return { backend: 'cpu' }
    } })
  try {
    checks.invalidate(); await until(() => !!complete)
    checks.invalidate(); complete!()
    await until(() => checks.get('model')?.state === 'passed')
    assert.equal(checks.get('model')?.execution?.backend, 'cpu')
    assert.equal(calls, 2)
  } finally { complete?.(); await checks.close() }
})

test('work preempts a probe, waits for cleanup, then resumes only when idle', async () => {
  let available = true, started = false, cleaned = false
  const checks = createModelValidation({ debounceMs: 1, available: () => available, changed() {}, targets: () => [{ variant: 'model' }],
    validate: async (_ref, signal) => {
      if (started) return { backend: 'cpu' }
      started = true
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      await delay(5); cleaned = true
      throw new Error('cancelled')
    } })
  try {
    checks.invalidate(); await until(() => started)
    await checks.pause(); available = false
    assert.equal(cleaned, true); assert.equal(checks.get('model')?.state, 'waiting')
    await delay(20); assert.equal(checks.get('model')?.state, 'waiting')
    available = true; checks.schedule(); await until(() => checks.get('model')?.state === 'passed')
  } finally { await checks.close() }
})

test('failed checks remain visible and do not loop until explicitly invalidated', async () => {
  let calls = 0
  const checks = createModelValidation({ debounceMs: 1, available: () => true, changed() {}, targets: () => [{ variant: 'model' }],
    validate: async () => { calls++; throw new Error('模型文件无法加载') } })
  try {
    checks.invalidate(); await until(() => checks.get('model')?.state === 'failed')
    checks.schedule(); await delay(20)
    assert.equal(calls, 1); assert.equal(checks.get('model')?.message, '模型文件无法加载')
  } finally { await checks.close() }
})
