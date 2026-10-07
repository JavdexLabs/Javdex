import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runSubtitleProcess, SubtitleProcessFailure } from './processRunner'

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
test('all offline child launches remove model, proxy and loader overrides while preserving explicit safe variables', async () => {
  const keys = ['LLAMA_ARG_MODEL', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HTTP_PROXY', 'https_proxy', 'ALL_PROXY',
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH']
  const inherited = { ...env, ...Object.fromEntries(keys.map(key => [key, 'fixture-override'])), JAVDEX_AI_TEST_SAFE: 'kept' }
  const output = await runSubtitleProcess(process.execPath, ['-e', `process.stdout.write(JSON.stringify({
    overrides: ${JSON.stringify(keys)}.filter(key => process.env[key] !== undefined), safe: process.env.JAVDEX_AI_TEST_SAFE
  }))`], { env: inherited })
  assert.deepEqual(JSON.parse(output), { overrides: [], safe: 'kept' })
})

test('offline child failures never expose decoder paths or grants', async () => {
  await assert.rejects(runSubtitleProcess(process.execPath, ['-e', "console.error('https://secret.invalid/grant');process.exit(7)"], { env }),
    error => error instanceof SubtitleProcessFailure && error.exitCode === 7 && !error.message.includes('secret'))
})
test('abort, timeout and oversized output terminate the owned inference child', async () => {
  const controller = new AbortController()
  const pending = runSubtitleProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /任务已取消/)
  await assert.rejects(runSubtitleProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, timeoutMs: 100 }), /任务超时/)
  await assert.rejects(runSubtitleProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], { env, maxBytes: 64 }), /结果超限/)
})
