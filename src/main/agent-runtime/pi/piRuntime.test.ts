import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  RuntimeDurableObservation,
  RuntimeObservation,
  RuntimeSessionInit
} from '../../agent-platform/types'
import { createPiRuntimePort } from './piRuntime'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  roots = []
})

function openAiStream(text: string): Response {
  const chunks = [
    {
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    }
  ]
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
  })
}

function openAiToolStream(): Response {
  const chunks = [
    {
      id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0, id: 'call-only', type: 'function',
            function: { name: 'only_tool', arguments: '{"value":"ok"}' }
          }]
        },
        finish_reason: null
      }]
    },
    {
      id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    }
  ]
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
  })
}

function runtimeInput(
  root: string,
  requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>
): RuntimeSessionInit {
  const systemText = 'Javdex controlled system prompt'
  const fakeFetch: typeof fetch = async (request, init) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    requests.push({ url, headers: new Headers(init?.headers), body })
    return openAiStream(`turn-${requests.length}`)
  }
  return {
    runId: 'run-pi-contract',
    model: {
      credentialRef: 'llm-provider:test',
      model: {
        providerId: 'test', modelId: 'test-model', name: 'Test Model', api: 'openai-completions',
        baseUrl: 'https://api.openai.com/v1', contextWindow: 32_000, maxTokens: 1_024, reasoning: false
      },
      routeRevision: 'rev:primary',
      preset: { thinkingLevel: 'minimal', maxTokens: 1_024, timeoutMs: 5_000, cacheRetention: 'short' },
      cacheCompatibility: {
        supportsPromptCache: true,
        supportsLongCacheRetention: true,
        sessionAffinityFormat: 'openai',
        sendSessionAffinityHeaders: true,
        evidence: { source: 'manual', checkedAt: '2026-01-01T00:00:00.000Z' }
      },
      getCredentialLease: async () => ({
        leaseId: 'lease', credentialRef: 'llm-provider:test', expiresAt: Date.now() + 60_000,
        resolve: () => 'test-key', revoke: () => undefined
      }),
      fetch: fakeFetch
    },
    cache: {
      primaryAffinityId: 'jvx_primary_affinity',
      verifierAffinityId: 'jvx_verifier_affinity',
      summarizerAffinityId: 'jvx_summarizer_affinity',
      retention: { primary: 'short', verifier: 'short', summarizer: 'short' }
    },
    systemPrompt: {
      text: systemText,
      sha256: createHash('sha256').update(systemText).digest('hex')
    },
    tools: [],
    settings: {
      compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 2_000 },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 }
    },
    sessionDirectory: root
  }
}

describe('PiRuntime contract', () => {
  it('keeps one long-lived session for ten turns with controlled resources and stable affinity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-runtime-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'this context must never be discovered', 'utf8')
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const observations: RuntimeObservation[] = []
    const durable: RuntimeDurableObservation[] = []
    let settle: (() => void) | undefined
    const observer = {
      notify: (event: RuntimeObservation) => observations.push(event),
      commit: async (event: RuntimeDurableObservation) => {
        durable.push(event)
        observations.push(event)
        if (event.type === 'agent.settled') settle?.()
      }
    }
    const port = createPiRuntimePort()
    const input = runtimeInput(root, requests)
    const opened = await port.open(input, observer)
    assert.equal(opened.source, 'created')

    for (let index = 0; index < 10; index += 1) {
      const settled = new Promise<void>((resolve) => { settle = resolve })
      const result = await opened.session.dispatch({
        commandId: `command-${index}`,
        kind: 'prompt',
        content: { text: `turn ${index}` }
      })
      assert.equal(result.accepted, true)
      await Promise.race([
        settled,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent_settled timeout')), 5_000))
      ])
    }

    assert.equal(requests.length, 10)
    assert.equal(fs.existsSync(opened.session.ref.sessionFile), true)
    for (const request of requests) {
      assert.match(request.url, /chat\/completions/)
      assert.equal(request.body.prompt_cache_key, input.cache.primaryAffinityId)
      assert.equal(request.headers.get('x-session-affinity'), input.cache.primaryAffinityId)
      const messages = request.body.messages as Array<{ role?: string; content?: string }>
      assert.equal(messages[0]?.role, 'system')
      assert.equal(messages[0]?.content, input.systemPrompt.text)
    }
    assert.equal(
      durable.filter((event) => event.type === 'agent.settled').length,
      10
    )
    assert.equal(
      durable.filter((event) => event.type === 'message.completed' && event.audit.role === 'assistant').length,
      10
    )
    assert.equal(observations.some((event) => event.type === 'runtime.fault'), false)
    const savedRef = structuredClone(opened.session.ref)
    await opened.session.dispose()

    const restored = await port.open({ ...input, resume: savedRef }, observer)
    assert.equal(restored.source, 'restored')
    const restoredSettled = new Promise<void>((resolve) => { settle = resolve })
    const restoredDispatch = await restored.session.dispatch({
      commandId: 'command-after-restart',
      kind: 'prompt',
      content: { text: 'continue after restart' }
    })
    assert.equal(restoredDispatch.accepted, true)
    await Promise.race([
      restoredSettled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('restored agent_settled timeout')), 5_000))
    ])
    assert.equal(requests.length, 11)
    assert.equal(requests.at(-1)?.body.prompt_cache_key, input.cache.primaryAffinityId)
    await restored.session.dispose()
  })

  it('exposes only the resolved custom allowlist and crosses the durable tool-result barrier', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-tool-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const durable: RuntimeDurableObservation[] = []
    let invocations = 0
    let requestCount = 0
    const input = runtimeInput(root, requests)
    input.tools = [{
      name: 'only_tool',
      label: 'Only tool',
      description: 'The only allowed tool',
      schema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false
      },
      schemaHash: 'schema-hash',
      capability: 'test.read',
      effect: 'read',
      executionMode: 'parallel',
      invoke: async ({ args }) => {
        invocations += 1
        return { ok: true, content: `tool:${String(args.value)}`, summary: 'tool ok' }
      }
    }]
    input.model.fetch = async (request, init) => {
      requestCount += 1
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      if (requestCount === 1) return openAiToolStream()
      assert.equal(durable.some((event) => event.type === 'tool.completed'), true)
      return openAiStream('finished')
    }
    let settle: (() => void) | undefined
    const opened = await createPiRuntimePort().open(input, {
      notify: () => undefined,
      commit: async (event) => {
        durable.push(event)
        if (event.type === 'agent.settled') settle?.()
      }
    })
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const dispatched = await opened.session.dispatch({
      commandId: 'tool-command', kind: 'prompt', content: { text: 'use the tool' }
    })
    assert.equal(dispatched.accepted, true)
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent_settled timeout')), 5_000))
    ])
    assert.equal(invocations, 1)
    assert.equal(requestCount, 2)
    const requestTools = requests[0]!.body.tools as Array<{ function?: { name?: string } }>
    assert.deepEqual(requestTools.map((tool) => tool.function?.name), ['only_tool'])
    assert.equal(durable.filter((event) => event.type === 'tool.completed').length, 1)
    await opened.session.dispose()
  })
})
