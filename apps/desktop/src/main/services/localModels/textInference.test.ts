import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn, SpawnOptions } from 'node:child_process'
import { createLocalTextInference } from './textInference'

test('standalone text inference needs only a translator and text weights and releases its owned process', async () => {
  const launches: Array<{ executable: string; args: string[]; options: SpawnOptions }> = []
  const prompts: string[] = []
  let closed = 0
  const launch = ((executable: string, args: string[], options: SpawnOptions) => {
    launches.push({ executable, args, options })
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null,
      kill() { closed++; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true } })
    return child as unknown as ChildProcess
  }) as typeof spawn
  const request: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${launches[0].options.env!.LLAMA_API_KEY}`)
    if (String(url).endsWith('/v1/models')) return Response.json({ data: [] })
    const body = JSON.parse(String(init?.body))
    prompts.push(body.messages[0].content)
    return Response.json({ choices: [{ message: { content: '  中文结果  ' }, finish_reason: 'stop' }] })
  }
  const engine = createLocalTextInference({ translator: '/tools/llama-server', translationModel: '/models/text.gguf', translationModelId: 'qwen3' },
    { spawn: launch, request, port: async () => 32102 })
  try {
    const signal = new AbortController().signal
    assert.equal(await engine.translateText('ABC-123', signal), '中文结果')
    assert.equal(await engine.translateText('説明', signal), '中文结果')
    assert.equal(launches.length, 1)
    assert.equal(launches[0].executable, '/tools/llama-server')
    assert.deepEqual(launches[0].args.slice(0, 2), ['-m', '/models/text.gguf'])
    assert.ok(prompts[0].endsWith('ABC-123'))
    assert.ok(prompts[1].endsWith('説明'))
  } finally { await engine.close() }
  assert.equal(closed, 1)
})

test('closing a translator that ignores graceful termination does not abandon its owned process', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: Array<NodeJS.Signals | undefined> = []
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals) {
      signals.push(signal)
      if (signal === 'SIGKILL') { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close', null, signal) }
      return true
    } })
  const engine = createLocalTextInference({ translator: '/fixture/llama-server', translationModel: '/fixture/model.gguf' }, {
    spawn: (() => child as unknown as ChildProcess) as typeof spawn,
    request: async () => Response.json({ data: [] }), port: async () => 32102
  })
  await engine.ready(new AbortController().signal)
  const closed = engine.close()
  t.mock.timers.tick(5000)
  await closed
  assert.ok(signals.includes('SIGKILL'), 'close must reap an unresponsive owned child before releasing it')
  assert.equal(child.signalCode, 'SIGKILL')
})
