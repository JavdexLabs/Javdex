import assert from 'node:assert/strict'
import { test } from 'node:test'
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { runLocalModelProcess, LocalModelProcessFailure } from './processRunner'

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
test('all offline child launches remove model, proxy and loader overrides while preserving explicit safe variables', async () => {
  const keys = ['LLAMA_ARG_MODEL', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HTTP_PROXY', 'https_proxy', 'ALL_PROXY',
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH']
  const inherited = { ...env, ...Object.fromEntries(keys.map(key => [key, 'fixture-override'])), JAVDEX_AI_TEST_SAFE: 'kept' }
  const output = await runLocalModelProcess(process.execPath, ['-e', `process.stdout.write(JSON.stringify({
    overrides: ${JSON.stringify(keys)}.filter(key => process.env[key] !== undefined), safe: process.env.JAVDEX_AI_TEST_SAFE
  }))`], { env: inherited })
  assert.deepEqual(JSON.parse(output), { overrides: [], safe: 'kept' })
})

test('offline child failures never expose decoder paths or grants', async () => {
  await assert.rejects(runLocalModelProcess(process.execPath, ['-e', "console.error('https://secret.invalid/grant');process.exit(7)"], { env }),
    error => error instanceof LocalModelProcessFailure && error.exitCode === 7 && !error.message.includes('secret'))
})
test('abort, timeout and oversized output terminate the owned inference child', async () => {
  const controller = new AbortController()
  const pending = runLocalModelProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /任务已取消/)
  await assert.rejects(runLocalModelProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, timeoutMs: 100 }), /任务超时/)
  await assert.rejects(runLocalModelProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], { env, maxBytes: 64 }), /结果超限/)
})

test('cancellation reaps a real owned child even when it ignores SIGTERM', { skip: process.platform === 'win32' }, async t => {
  const originalSpawn = childProcess.spawn
  let child: ChildProcessWithoutNullStreams | null = null, closed = false
  let ready!: () => void
  const initialized = new Promise<void>(resolve => { ready = resolve })
  // Retain the actual owned handle, never infer ownership or kill another process by a reused PID.
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof originalSpawn>) => {
    child = originalSpawn(...args) as ChildProcessWithoutNullStreams
    child.stdout.on('data', (data: Buffer) => { if (data.toString().includes('ready')) ready() })
    child.once('close', () => { closed = true })
    return child
  })
  syncBuiltinESMExports()
  const controller = new AbortController()
  const pending = runLocalModelProcess(process.execPath, ['-e', `process.on('SIGTERM',()=>{});
    process.stdout.write('ready');setInterval(()=>{},1000)`], { env, signal: controller.signal })
  void pending.catch(() => {})
  let deadline: NodeJS.Timeout | undefined
  try {
    await Promise.race([initialized, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('owned child did not initialize')), 5000)
    })])
    clearTimeout(deadline)
    controller.abort()
    await assert.rejects(Promise.race([pending, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('owned child was not reaped within the cancellation bound')), 3500)
    })]), /任务已取消/)
    assert.equal(closed, true, 'the wrapper must wait for its actual owned child close event')
    assert.equal((child as ChildProcessWithoutNullStreams | null)?.signalCode, 'SIGKILL')
  } finally {
    if (deadline) clearTimeout(deadline)
    const owned = child as ChildProcessWithoutNullStreams | null
    if (owned && !closed) owned.kill('SIGKILL')
    await pending.catch(() => {})
    t.mock.restoreAll(); syncBuiltinESMExports()
  }
})
