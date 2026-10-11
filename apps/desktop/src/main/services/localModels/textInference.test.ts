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
