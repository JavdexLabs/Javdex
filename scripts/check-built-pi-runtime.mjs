#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const chunksDirectory = path.resolve('out/main/chunks')
const piSdkChunks = readdirSync(chunksDirectory).filter(
  (name) => name.startsWith('piSdk-') && name.endsWith('.js')
)
assert.equal(piSdkChunks.length, 1, `Expected one built Pi SDK chunk, found ${piSdkChunks.length}`)

const require = createRequire(import.meta.url)
const builtModule = require(path.join(chunksDirectory, piSdkChunks[0]))
const sdk = builtModule.piSdk ?? builtModule
for (const name of [
  'AgentSession',
  'DefaultResourceLoader',
  'ModelRuntime',
  'SessionManager',
  'SettingsManager',
  'createAgentSession'
]) {
  assert.equal(typeof sdk[name], 'function', `Built Pi SDK is missing ${name}`)
}

const root = mkdtempSync(path.join(tmpdir(), 'javdex-built-pi-runtime-'))
try {
  const settingsManager = sdk.SettingsManager.inMemory({
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    defaultTools: []
  }, { projectTrusted: false })
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, 'agent'),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on('tool_call', () => undefined)
      }
    ]
  })
  await resourceLoader.reload()
  assert.equal(resourceLoader.getExtensions().extensions.length, 1)
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: {
      read: async () => ({ type: 'api_key', key: 'fixture-only' }),
      list: async () => [], modify: async () => undefined, delete: async () => undefined
    },
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false
  })
  for (const api of ['openai-responses', 'google-generative-ai']) {
    const id = `built-${api}`
    modelRuntime.registerProvider(id, { name: id, api, baseUrl: 'https://fixture.invalid/v1', models: [{
      id: 'test-model', name: 'Test', api, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024
    }] })
    let requests = 0
    const request = async url => {
      requests++
      assert.match(String(url), api === 'openai-responses' ? /\/responses$/ : /:streamGenerateContent/)
      const data = api === 'openai-responses' ? {
        type: 'response.completed', response: { id: 'resp_built', status: 'completed',
          output: [{ type: 'message', id: 'msg_built', role: 'assistant', content: [{ type: 'output_text', text: 'BUILT_OK' }] }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }
      } : { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'BUILT_OK' }] } }] }
      const chunks = api === 'openai-responses' ? [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_built', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'BUILT_OK' },
        { type: 'response.output_item.done', output_index: 0, item: data.response.output[0] },
        data
      ] : [data]
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const result = await modelRuntime.streamSimple(modelRuntime.getModel(id, 'test-model'), {
      messages: [{ role: 'user', content: 'Test', timestamp: 1 }]
    }, { fetch: request, maxTokens: 1024 }).result()
    assert.equal(result.stopReason, 'stop', result.errorMessage)
    assert.equal(result.content.find(part => part.type === 'text')?.text, 'BUILT_OK')
    assert.equal(requests, 1, `${api} must use the injected transport in the production bundle`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`Built Pi runtime verified: ${piSdkChunks[0]}`)
