import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetSettingsCacheForTests } from '../../settings/settingsStore'
import { requestResponsesJson, requestResponsesText } from './adapters/openaiResponsesAdapter'
import { requestGoogleJson, requestGoogleText } from './adapters/googleGenerativeAdapter'
import { requestAnthropicJson } from './adapters/anthropicMessagesAdapter'
import { llmRequestEndpoints, type ResolvedLlmModelRequestConfig } from '../llmClient'
import { listResolvedLlmProviderModels, testResolvedLlmModelConnection } from '../llmConnectionTest'
import { ModelInvocation } from '../../agent-platform/modelInvocation'
import { translateCloudTextToChinese } from '../llmTextTranslate'
import type { ResolvedModelAccess } from '../../agent-platform/types'

let root: string
let previousUserData: string | undefined
const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = []
let respond: (url: string, init?: RequestInit) => Response

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-native-protocols-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  resetSettingsCacheForTests()
  requests.length = 0
  respond = () => Response.json({})
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    requests.push({ url: target, init, body: init?.body ? JSON.parse(String(init.body)) : {} })
    return respond(target, init)
  })
})

afterEach(() => {
  mock.restoreAll()
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(root, { recursive: true, force: true })
})

function config(protocol: 'openai-responses' | 'google-generative-ai'): ResolvedLlmModelRequestConfig {
  const baseUrl = protocol === 'openai-responses' ? 'https://example.test/v1' : 'https://example.test/v1beta'
  return {
    protocol, baseUrl, providerId: 'test', providerName: 'Test', local: false, apiKey: 'test-key',
    modelId: 'test-model', maxTokens: 2048, ...llmRequestEndpoints(protocol, baseUrl)
  }
}

function responses(text: string) {
  return { status: 'completed', output: [
    { type: 'reasoning', summary: [{ text: 'hidden reasoning' }] },
    { type: 'message', content: [{ type: 'output_text', text }] }
  ], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
    input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 4 } } }
}

function google(text: string) {
  return { candidates: [{ finishReason: 'STOP', content: { parts: [
    { thought: true, text: 'hidden reasoning' }, { text }
  ] } }], usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 5, candidatesTokenCount: 6,
    thoughtsTokenCount: 4, totalTokenCount: 30 } }
}

describe('native cloud protocols', () => {
  it('uses MiniMax Messages for probes, translation, JSON and discovery without exposing thinking as output', async () => {
    const baseUrl = 'https://gateway.example/minimax/anthropic'
    const input: ResolvedLlmModelRequestConfig = {
      protocol: 'anthropic-messages', providerId: 'minimax', providerName: 'MiniMax', baseUrl,
      local: false, apiKey: 'test-key', modelId: 'MiniMax-M2.7',
      ...llmRequestEndpoints('anthropic-messages', baseUrl)
    }
    const response = (text: string) => Response.json({ content: [
      { type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text }
    ] })
    respond = () => response('JAVDEX_OK')
    assert.equal(await testResolvedLlmModelConnection(input), 'JAVDEX_OK')
    assert.equal(requests[0].body.max_tokens, 2048)
    respond = () => response('译文')
    assert.equal(await translateCloudTextToChinese('Hello', input), '译文')
    assert.equal(requests[1].body.max_tokens, 2048)
    respond = () => response('{"ok":true}')
    assert.deepEqual((await requestAnthropicJson([{ role: 'user', content: 'Return JSON' }], input)).json, { ok: true })
    for (const request of requests) {
      assert.equal(request.url, `${baseUrl}/v1/messages`)
      assert.equal(new Headers(request.init?.headers).get('x-api-key'), 'test-key')
    }
    respond = () => Response.json({ data: [{ id: 'MiniMax-M2.7', display_name: 'MiniMax M2.7' }] })
    const models = await listResolvedLlmProviderModels(input)
    assert.equal(models[0].id, 'MiniMax-M2.7')
    assert.equal(requests.at(-1)?.url, `${baseUrl}/v1/models`)
    respond = () => Response.json({ error: { message: 'Invalid key' } }, { status: 401 })
    await assert.rejects(listResolvedLlmProviderModels(input), /Invalid key/)
  })

  it('retains MiniMax Chat compatibility and leaves other providers probe budgets unchanged', async () => {
    const baseUrl = 'https://saved.example/v1'
    const input: ResolvedLlmModelRequestConfig = { providerId: 'minimax', providerName: 'MiniMax',
      protocol: 'openai-chat', baseUrl, local: false, apiKey: 'test-key', modelId: 'MiniMax-M2.7',
      ...llmRequestEndpoints('openai-chat', baseUrl) }
    respond = () => Response.json({ choices: [{ message: { content: 'JAVDEX_OK' } }] })
    await testResolvedLlmModelConnection(input)
    assert.equal(requests[0].url, `${baseUrl}/chat/completions`)
    assert.equal(requests[0].body.max_tokens, 2048)
    await testResolvedLlmModelConnection({ ...input, providerId: 'deepseek' })
    assert.equal(requests[1].body.max_tokens, 128)
  })

  it('uses Responses input/text.format and parses typed output and token accounting', async () => {
    respond = () => Response.json(responses('{"ok":true}'))
    const result = await requestResponsesJson<{ ok: boolean }>([
      { role: 'system', content: 'Return JSON' }, { role: 'user', content: 'Check' }
    ], config('openai-responses'))
    assert.deepEqual(result.json, { ok: true })
    assert.equal(requests[0].url, 'https://example.test/v1/responses')
    assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer test-key')
    assert.equal(requests[0].body.store, false)
    assert.deepEqual(requests[0].body.text, { format: { type: 'json_object' } })
    assert.equal('messages' in requests[0].body, false)
    assert.equal('temperature' in requests[0].body, false)
    assert.deepEqual(result.usage, { input: 20, uncachedInput: 15, output: 10, reasoning: 4, cacheRead: 5, cacheWrite: 0, totalTokens: 30 })
  })

  it('uses Gemini native authentication/content and excludes thought parts from JSON', async () => {
    respond = () => Response.json(google('{"ok":true}'))
    const result = await requestGoogleJson<{ ok: boolean }>([
      { role: 'system', content: 'Return JSON' }, { role: 'user', content: 'Check' }
    ], { ...config('google-generative-ai'), modelId: 'models/test-model' })
    assert.deepEqual(result.json, { ok: true })
    assert.equal(requests[0].url, 'https://example.test/v1beta/models/test-model:generateContent')
    assert.equal(new Headers(requests[0].init?.headers).get('x-goog-api-key'), 'test-key')
    assert.equal(new Headers(requests[0].init?.headers).has('authorization'), false)
    assert.deepEqual(requests[0].body.systemInstruction, { parts: [{ text: 'Return JSON' }] })
    assert.deepEqual(requests[0].body.generationConfig, { maxOutputTokens: 2048, responseMimeType: 'application/json' })
    assert.deepEqual(result.usage, { input: 20, uncachedInput: 15, output: 10, reasoning: 4, cacheRead: 5, cacheWrite: 0, totalTokens: 30 })
  })

  it('does not accept truncated, refused or malformed output as successful JSON', async () => {
    const messages = [{ role: 'user' as const, content: 'JSON please' }]
    respond = () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    await assert.rejects(requestResponsesJson(messages, config('openai-responses')), /max_output_tokens/)
    respond = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] })
    await assert.rejects(requestResponsesJson(messages, config('openai-responses')), /拒绝/)
    respond = () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"ok":true}' }] } }] })
    await assert.rejects(requestGoogleJson(messages, config('google-generative-ai')), /MAX_TOKENS/)
    respond = () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } })
    await assert.rejects(requestGoogleJson(messages, config('google-generative-ai')), /SAFETY/)
    respond = () => Response.json(responses('not JSON'))
    await assert.rejects(requestResponsesJson(messages, config('openai-responses')), /JSON 格式/)
  })

  it('discovers all Gemini pages, strips resource prefixes and distinguishes embeddings', async () => {
    respond = url => Response.json(url.includes('pageToken=next') ? {
      models: [{ name: 'models/embed-test', displayName: 'Embed', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/chat-test', supportedGenerationMethods: ['generateContent'] }]
    } : { models: [
      { name: 'models/chat-test', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/image-only', supportedGenerationMethods: ['predict'] }
    ], nextPageToken: 'next' })
    const models = await listResolvedLlmProviderModels(config('google-generative-ai'))
    assert.deepEqual(models.map(item => [item.id, item.kind]), [['chat-test', 'chat'], ['embed-test', 'embedding']])
    assert.equal(requests.length, 2)
    assert.equal(new Headers(requests[1].init?.headers).get('x-goog-api-key'), 'test-key')
    respond = () => Response.json({ nextPageToken: 'same' })
    await assert.rejects(listResolvedLlmProviderModels(config('google-generative-ai')), /分页异常/)
  })

  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const) {
    it(`cancels ${protocol} during Retry-After without issuing another request`, { timeout: 5000 }, async () => {
      const controller = new AbortController()
      respond = () => Response.json({ error: { message: 'busy' } }, {
        status: 429, headers: { 'retry-after': '60' }
      })
      const probe = testResolvedLlmModelConnection({
        providerId: 'test', providerName: 'Test', local: false, apiKey: 'test-key', modelId: 'test-model',
        protocol, baseUrl: 'https://example.test/v1',
        ...llmRequestEndpoints(protocol, 'https://example.test/v1'), signal: controller.signal
      })
      // Let the response enter its retry wait before cancelling it.
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(requests.length, 1)
      controller.abort()
      await assert.rejects(probe, { name: 'AbortError' })
      assert.equal(requests.length, 1)
    })
  }

  for (const protocol of ['openai-responses', 'google-generative-ai'] as const) {
    it(`runs ${protocol} connection probes, retries transient HTTP failures and honors cancellation`, async () => {
      let attempts = 0
      respond = () => ++attempts === 1
        ? Response.json({ error: { message: 'busy' } }, { status: 429, headers: { 'retry-after': '0' } })
        : Response.json(protocol === 'openai-responses' ? responses('JAVDEX_OK') : google('JAVDEX_OK'))
      assert.equal(await testResolvedLlmModelConnection(config(protocol)), 'JAVDEX_OK')
      assert.equal(attempts, 2)
      respond = () => Response.json({ error: { message: 'invalid key' } }, { status: 401 })
      await assert.rejects(testResolvedLlmModelConnection(config(protocol)), /invalid key/)
      const controller = new AbortController()
      controller.abort()
      mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        assert.equal(init?.signal?.aborted, true)
        init!.signal!.throwIfAborted()
        return Response.json({})
      })
      await assert.rejects(testResolvedLlmModelConnection({ ...config(protocol), signal: controller.signal }), { name: 'AbortError' })
    })

    it(`routes frozen verifier access and application translation through ${protocol}`, async () => {
      const requestConfig = config(protocol)
      const access: ResolvedModelAccess = {
        credentialRef: 'llm-provider:test', routeRevision: 'revision',
        model: { providerId: 'test', modelId: 'test-model', name: 'Test', api: protocol,
          baseUrl: requestConfig.baseUrl, contextWindow: 32000, maxTokens: 2048, reasoning: false },
        preset: { thinkingLevel: 'minimal', maxTokens: 2048, timeoutMs: 3000, cacheRetention: 'none' },
        cacheCompatibility: { supportsPromptCache: false, supportsLongCacheRetention: false, sendSessionAffinityHeaders: false,
          evidence: { source: 'manual', checkedAt: '2026-10-11' } },
        getCredentialLease: async () => ({ leaseId: 'test', credentialRef: 'test', expiresAt: Date.now() + 60000,
          resolve: () => 'test-key', revoke: () => {} })
      }
      respond = () => Response.json(protocol === 'openai-responses' ? responses('{"ok":true}') : google('{"ok":true}'))
      const verified = await new ModelInvocation().requestJson<{ ok: boolean }>({ access, messages: [{ role: 'user', content: 'Return JSON' }] })
      assert.equal(verified.json.ok, true)
      assert.equal(verified.usage?.reasoning, 4)
      respond = () => Response.json(protocol === 'openai-responses' ? responses('中文译文') : google('中文译文'))
      assert.equal(await translateCloudTextToChinese('説明', requestConfig), '中文译文')
      assert.equal('response_format' in requests.at(-1)!.body, false)
    })
  }

  it('uses /models for Responses discovery without sending a generation request', async () => {
    respond = () => Response.json({ data: [{ id: 'test-model' }] })
    assert.equal((await listResolvedLlmProviderModels(config('openai-responses')))[0].id, 'test-model')
    assert.equal(requests[0].url, 'https://example.test/v1/models')
    assert.equal(requests[0].init?.method, 'GET')
  })

  it('keeps plain-text requests free of JSON formatting options', async () => {
    respond = () => Response.json(responses('text'))
    await requestResponsesText([{ role: 'user', content: 'translate' }], config('openai-responses'))
    assert.equal('text' in requests[0].body, false)
    respond = () => Response.json(google('text'))
    await requestGoogleText([{ role: 'user', content: 'translate' }], config('google-generative-ai'))
    assert.deepEqual(requests[1].body.generationConfig, { maxOutputTokens: 2048 })
  })
})
