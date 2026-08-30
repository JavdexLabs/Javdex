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
import {
  createPiRuntimePort,
  validatePluginWorkspaceToolAccess
} from './piRuntime'

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

function openAiLengthStream(reasoning = 'drafting code'): Response {
  const chunks = [
    {
      id: 'chatcmpl-length', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: reasoning }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-length', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 1_024, total_tokens: 1_924 }
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
  it('allows workspace reads and dev notes but keeps host-owned facts read-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-native-policy-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-native-outside-'))
    roots.push(root, outside)
    fs.writeFileSync(path.join(root, 'plugin.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(root, 'index.js'), '', 'utf8')
    fs.mkdirSync(path.join(root, '.javdex'), { recursive: true })
    fs.writeFileSync(path.join(root, '.javdex', 'dev-notes.md'), '', 'utf8')
    fs.writeFileSync(path.join(root, '.javdex', 'latest-dry-run.json'), '{}', 'utf8')
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'outside-link'))

    assert.equal(validatePluginWorkspaceToolAccess(root, 'find', { pattern: '**/*' }), undefined)
    assert.equal(validatePluginWorkspaceToolAccess(root, 'read', { path: 'docs' }), undefined)
    assert.equal(validatePluginWorkspaceToolAccess(root, 'edit', { path: 'index.js' }), undefined)
    assert.equal(
      validatePluginWorkspaceToolAccess(root, 'edit', { path: '.javdex/dev-notes.md' }),
      undefined
    )
    assert.match(
      validatePluginWorkspaceToolAccess(root, 'write', { path: '.javdex/latest-dry-run.json' }) ?? '',
      /只允许修改/
    )
    assert.match(
      validatePluginWorkspaceToolAccess(root, 'write', { path: 'docs/plugin-format.md' }) ?? '',
      /只允许修改/
    )
    assert.match(
      validatePluginWorkspaceToolAccess(root, 'read', { path: 'outside-link/secret.txt' }) ?? '',
      /工作区之外/
    )
    assert.match(validatePluginWorkspaceToolAccess(root, 'bash', {}) ?? '', /未启用 shell/)
  })

  it('loads only frozen workspace Skills and exposes the selected Pi native file tools', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-native-workspace-'))
    roots.push(root)
    const skillDirectory = path.join(root, '.agents', 'skills', 'javdex-plugin-dev')
    fs.mkdirSync(skillDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: javdex-plugin-dev\ndescription: Develop the current plugin.\n---\n\nRead task.json.\n',
      'utf8'
    )
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const input = runtimeInput(root, requests)
    const skillText = fs.readFileSync(path.join(skillDirectory, 'SKILL.md'), 'utf8')
    input.resources = {
      nativeTools: ['read', 'write', 'edit', 'grep', 'find', 'ls'],
      skillNames: ['javdex-plugin-dev'],
      skillHashes: {
        'javdex-plugin-dev': createHash('sha256').update(skillText).digest('hex')
      }
    }
    let settle: (() => void) | undefined
    const port = createPiRuntimePort()
    const opened = await port.open(input, {
      notify: () => undefined,
      commit: async (event) => {
        if (event.type === 'agent.settled') settle?.()
      }
    })
    const settled = new Promise<void>((resolve) => { settle = resolve })
    await opened.session.dispatch({
      commandId: 'native-workspace-command',
      kind: 'prompt',
      content: { text: 'inspect the workspace' }
    })
    await settled

    const request = requests[0]?.body
    const tools = (request?.tools as Array<{ function?: { name?: string } }> | undefined) ?? []
    assert.deepEqual(
      tools.map((tool) => tool.function?.name).sort(),
      ['edit', 'find', 'grep', 'ls', 'read', 'write']
    )
    const messages = request?.messages as Array<{ role?: string; content?: string }>
    assert.match(messages[0]?.content ?? '', /javdex-plugin-dev/)
    assert.doesNotMatch(messages[0]?.content ?? '', /this context must never be discovered/)
    await opened.session.dispose()
  })

  it('rejects a workspace Skill that differs from the frozen run configuration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-skill-hash-'))
    roots.push(root)
    const skillDirectory = path.join(root, '.agents', 'skills', 'javdex-plugin-dev')
    fs.mkdirSync(skillDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: javdex-plugin-dev\ndescription: Changed after freeze.\n---\n',
      'utf8'
    )
    const input = runtimeInput(root, [])
    input.resources = {
      nativeTools: [],
      skillNames: ['javdex-plugin-dev'],
      skillHashes: { 'javdex-plugin-dev': '0'.repeat(64) }
    }

    await assert.rejects(
      createPiRuntimePort().open(input, {
        notify: () => undefined,
        commit: async () => undefined
      }),
      /frozen Skill hash mismatch/
    )
  })

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

  it('keeps the run healthy when Pi recovers from a transient provider error', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-retry-recovered-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const durable: RuntimeDurableObservation[] = []
    const input = runtimeInput(root, requests)
    input.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 5 }
    let toolInvocations = 0
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
      invoke: async () => {
        toolInvocations += 1
        return { ok: true, content: 'tool:ok', summary: 'tool ok' }
      }
    }]
    let requestCount = 0
    input.model.fetch = async (request, init) => {
      requestCount += 1
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      if (requestCount === 1) throw new Error('Connection error.')
      if (requestCount === 2) return openAiToolStream()
      return openAiStream('recovered')
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
      commandId: 'retry-recovered-command', kind: 'prompt', content: { text: 'recover once' }
    })
    assert.equal(dispatched.accepted, true)
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent_settled timeout')), 5_000))
    ])

    assert.equal(requestCount, 3)
    assert.equal(toolInvocations, 1, 'custom tools must remain usable after the provider retry recovers')
    assert.deepEqual(
      durable
        .filter((event) => event.type === 'retry.changed')
        .map((event) => event.type === 'retry.changed' ? event.phase : undefined),
      ['start', 'end']
    )
    assert.equal(
      durable.some((event) => event.type === 'runtime.fault'),
      false,
      'an intermediate provider attempt must not terminalize a recovered run'
    )
    assert.equal(durable.filter((event) => event.type === 'agent.settled').length, 1)
    await opened.session.dispose()
  })

  it('emits one terminal runtime fault after provider retries are exhausted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-retry-exhausted-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const durable: RuntimeDurableObservation[] = []
    const input = runtimeInput(root, requests)
    input.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 5 }
    input.model.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      throw new Error('Connection error.')
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
      commandId: 'retry-exhausted-command', kind: 'prompt', content: { text: 'fail twice' }
    })
    assert.equal(dispatched.accepted, true)
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent_settled timeout')), 5_000))
    ])

    assert.equal(requests.length, 2)
    const faults = durable.filter((event) => event.type === 'runtime.fault')
    assert.equal(faults.length, 1)
    assert.equal(faults[0]?.type === 'runtime.fault' ? faults[0].message : '', 'Connection error.')
    assert.ok(durable.indexOf(faults[0]!) < durable.findIndex((event) => event.type === 'agent.settled'))
    await opened.session.dispose()
  })

  it('does not turn a user-cancelled provider retry into a runtime fault', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-retry-cancelled-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const durable: RuntimeDurableObservation[] = []
    const input = runtimeInput(root, requests)
    input.settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 10_000 }
    input.model.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      throw new Error('Connection error.')
    }
    let retryStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { retryStarted = resolve })
    const opened = await createPiRuntimePort().open(input, {
      notify: () => undefined,
      commit: async (event) => {
        durable.push(event)
        if (event.type === 'retry.changed' && event.phase === 'start') retryStarted?.()
      }
    })
    const dispatched = await opened.session.dispatch({
      commandId: 'retry-cancelled-command', kind: 'prompt', content: { text: 'cancel retry' }
    })
    assert.equal(dispatched.accepted, true)
    await Promise.race([
      started,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('retry_start timeout')), 5_000))
    ])
    await opened.session.abort()

    assert.equal(requests.length, 1)
    assert.equal(durable.some((event) => event.type === 'runtime.fault'), false)
    await opened.session.dispose()
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

  it('honors a terminating control result even when the domain tool reports failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-tool-terminate-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const durable: RuntimeDurableObservation[] = []
    let invocations = 0
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
      invoke: async () => {
        invocations += 1
        return {
          ok: false,
          content: 'DRY_RUN_STALLED: waiting for user',
          summary: 'dry-run stalled',
          terminate: true
        }
      }
    }]
    input.model.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      return openAiToolStream()
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
      commandId: 'terminating-tool-command',
      kind: 'prompt',
      content: { text: 'use the tool' }
    })
    assert.equal(dispatched.accepted, true)
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent_settled timeout')), 5_000))
    ])

    assert.equal(invocations, 1)
    assert.equal(requests.length, 1)
    assert.equal(
      durable.some(
        (event) => event.type === 'tool.completed' && event.result.ok === false
      ),
      true
    )
    assert.equal(durable.some((event) => event.type === 'runtime.fault'), false)
    await opened.session.dispose()
  })

  it('starts a new turn when a follow-up is dispatched after a terminating handoff settled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-handoff-resume-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
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
      invoke: async () => ({
        ok: true,
        content: 'waiting for user',
        summary: 'browser handoff',
        terminate: true
      })
    }]
    input.model.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      return requests.length === 1 ? openAiToolStream() : openAiStream('resumed')
    }
    let settledCount = 0
    let resolveSettled: (() => void) | undefined
    const opened = await createPiRuntimePort().open(input, {
      notify: () => undefined,
      commit: async (event) => {
        if (event.type !== 'agent.settled') return
        settledCount += 1
        resolveSettled?.()
      }
    })
    const waitForNextSettle = (): Promise<void> => new Promise((resolve) => {
      resolveSettled = resolve
    })

    const firstSettled = waitForNextSettle()
    assert.equal((await opened.session.dispatch({
      commandId: 'handoff-command', kind: 'prompt', content: { text: 'request handoff' }
    })).accepted, true)
    await firstSettled

    const resumedSettled = waitForNextSettle()
    assert.equal((await opened.session.dispatch({
      commandId: 'resume-command', kind: 'follow-up', content: { text: 'continue after login' }
    })).accepted, true)
    await Promise.race([
      resumedSettled,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('resumed agent_settled timeout')),
        500
      ))
    ])

    assert.equal(settledCount, 2)
    assert.equal(requests.length, 2)
    await opened.session.dispose()
  })

  it('does not compact or inject a host recovery prompt after a length stop', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-length-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const durable: RuntimeDurableObservation[] = []
    const input = runtimeInput(root, requests)
    input.model.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      return requests.length === 1
        ? openAiLengthStream('drafting code '.repeat(3_000))
        : openAiStream('host must not continue')
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
      commandId: 'length-command', kind: 'prompt', content: { text: 'build the plugin' }
    })
    assert.equal(dispatched.accepted, true)
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent_settled timeout')), 5_000))
    ])

    assert.equal(requests.length, 1, 'the host must not compact or prompt after Pi settles a length stop')
    const truncated = durable.find(
      (event) => event.type === 'message.completed' && event.audit.role === 'assistant'
    )
    assert.ok(truncated?.type === 'message.completed')
    assert.equal(truncated.audit.stopReason, 'length')
    assert.equal(durable.filter((event) => event.type === 'compaction.changed').length, 0)
    assert.equal(durable.filter((event) => event.type === 'runtime.fault').length, 0)
    assert.equal(durable.filter((event) => event.type === 'agent.settled').length, 1)
    await opened.session.dispose()
  })

  it('does not start a host continuation after the model-turn budget stops the operation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-length-turn-budget-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const durable: RuntimeDurableObservation[] = []
    const input = runtimeInput(root, requests)
    input.settings.maxTurns = 1
    input.model.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      return requests.length === 1
        ? openAiLengthStream('drafting code '.repeat(3_000))
        : openAiStream('must not run')
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
      commandId: 'length-turn-budget-command', kind: 'prompt', content: { text: 'build the plugin' }
    })
    assert.equal(dispatched.accepted, true)
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent_settled timeout')), 5_000))
    ])

    assert.equal(requests.length, 1, 'the terminal turn-budget decision must suppress recovery requests')
    assert.deepEqual(
      durable.filter((event) => event.type === 'limit.reached'),
      [{ type: 'limit.reached', resource: 'model-turns', current: 1, limit: 1 }]
    )
    assert.equal(durable.filter((event) => event.type === 'compaction.changed').length, 0)
    assert.equal(durable.filter((event) => event.type === 'agent.settled').length, 1)
    await opened.session.dispose()
  })

  it('enforces the configured per-operation model-turn budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pi-turn-budget-'))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const durable: RuntimeDurableObservation[] = []
    let invocations = 0
    const input = runtimeInput(root, requests)
    input.settings.maxTurns = 1
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
      invoke: async () => {
        invocations += 1
        return { ok: true, content: 'tool:ok', summary: 'tool ok' }
      }
    }]
    input.model.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url, headers: new Headers(init?.headers), body })
      return openAiToolStream()
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
      commandId: 'turn-budget-command', kind: 'prompt', content: { text: 'use the tool' }
    })
    assert.equal(dispatched.accepted, true)
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent_settled timeout')), 5_000))
    ])

    assert.equal(requests.length, 1)
    assert.equal(invocations, 1)
    assert.deepEqual(
      durable.filter((event) => event.type === 'limit.reached'),
      [{ type: 'limit.reached', resource: 'model-turns', current: 1, limit: 1 }]
    )
    assert.equal(durable.filter((event) => event.type === 'agent.settled').length, 1)
    await opened.session.dispose()
  })
})
