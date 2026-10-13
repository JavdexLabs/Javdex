import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settingsTypes'
import { BUILT_IN_LLM_CATALOG_VERSION } from '@shared/llmProviders'
import type { ResolvedLlmModelRequestConfig, ResolvedLlmRequestConfig } from '../services/llmClient'
import type {
  ModelCandidate,
  ModelManagementDocument,
  ModelManagementSnapshot
} from '@shared/modelManagementTypes'
import {
  buildLegacyLlmSettingsBackup,
  migrateModelManagementDocument,
  ModelManagementError,
  ModelManagementModule,
  type CredentialVaultPort,
  type ModelConfigurationStore,
  type ProviderTransportPort
} from './modelManagement'

class MemoryStore implements ModelConfigurationStore {
  value: unknown | null
  backups = 0
  writes = 0
  failWrite = false

  constructor(value: unknown | null = null) {
    this.value = value
  }

  read(): unknown | null {
    return this.value === null ? null : structuredClone(this.value)
  }

  write(document: ModelManagementDocument): void {
    this.writes += 1
    if (this.failWrite) throw new Error('disk full')
    this.value = structuredClone(document)
  }

  backupLegacySettings(): void {
    this.backups += 1
  }
}

class MemoryCredentials implements CredentialVaultPort {
  readonly values = new Map<string, string>()
  writes = 0

  has(providerId: string): boolean {
    return Boolean(this.values.get(providerId))
  }

  read(providerId: string): string {
    return this.values.get(providerId) ?? ''
  }

  write(providerId: string, value: string): void {
    this.writes += 1
    this.values.set(providerId, value)
  }

  remove(providerId: string): void {
    this.writes += 1
    this.values.delete(providerId)
  }
}

class FakeTransport implements ProviderTransportPort {
  discoverCalls = 0
  testCalls = 0
  candidates: ModelCandidate[] = [{ id: 'remote-chat', name: 'Remote Chat', kind: 'chat' }]

  async discover(_config: ResolvedLlmRequestConfig): Promise<ModelCandidate[]> {
    this.discoverCalls += 1
    return structuredClone(this.candidates)
  }

  async test(_config: ResolvedLlmModelRequestConfig): Promise<string> {
    this.testCalls += 1
    return 'JAVDEX_OK'
  }
}

function harness(input?: {
  stored?: unknown | null
  settings?: AppSettings
}) {
  const store = new MemoryStore(input?.stored ?? null)
  const credentials = new MemoryCredentials()
  credentials.values.set('deepseek', 'sk-deepseek')
  credentials.values.set('openai', 'sk-openai')
  const transport = new FakeTransport()
  let revision = 0
  const module = new ModelManagementModule({
    store,
    credentials,
    providerTransport: transport,
    readLegacySettings: () => structuredClone(input?.settings ?? DEFAULT_SETTINGS),
    now: () => new Date('2026-08-22T00:00:00.000Z'),
    nextRevision: () => `revision-${++revision}`
  })
  return { module, store, credentials, transport }
}

function assignment(snapshot: ModelManagementSnapshot, workloadId: string) {
  return snapshot.assignments.find((item) => item.workloadId === workloadId)!
}

describe('ModelManagementModule', () => {
  it('defaults new MiniMax connections to Messages and retains saved Chat connections and bindings', async () => {
    const fresh = harness()
    let snapshot = fresh.module.read()
    const connection = snapshot.connections.find(item => item.providerId === 'minimax')!
    const model = snapshot.models.find(item => item.connectionId === connection.id)!
    assert.equal(connection.protocol, 'anthropic-messages')
    assert.equal(connection.baseUrl, 'https://api.minimax.cn/anthropic')
    fresh.credentials.values.set('minimax', 'test-key')
    snapshot = fresh.module.apply({ expectedRevision: snapshot.revision, command: { type: 'set-default-model', modelRef: model.id } })
    assert.equal(fresh.module.resolve('app-default').model.api, 'anthropic-messages')
    fresh.transport.test = async config => {
      assert.equal(config.messagesUrl, 'https://api.minimax.cn/anthropic/v1/messages')
      assert.equal(config.apiKey, 'test-key')
      return 'JAVDEX_OK'
    }
    await fresh.module.testModel(model.id, new AbortController().signal)
    const stored = structuredClone(fresh.store.value) as ModelManagementDocument
    const savedConnection = stored.connections.find(item => item.id === connection.id)!
    savedConnection.protocol = 'openai-chat'
    savedConnection.baseUrl = 'https://api.minimaxi.com/v1'
    for (const savedModel of stored.models.filter(item => item.connectionId === connection.id)) {
      savedModel.baseline.api = 'openai-completions'
    }
    stored.builtinCatalogVersion = BUILT_IN_LLM_CATALOG_VERSION - 1
    const restored = harness({ stored })
    restored.credentials.values.set('minimax', 'test-key')
    const result = restored.module.read()
    assert.deepEqual((restored.store.value as ModelManagementDocument).connections, stored.connections)
    assert.deepEqual(result.assignments, snapshot.assignments)
    assert.equal(restored.module.resolve('app-default').model.api, 'openai-completions')
    assert.equal(restored.module.resolve('app-default').model.baseUrl, savedConnection.baseUrl)
  })

  it('demotes referenced retired presets and retains current presets, identities, overrides and bindings', () => {
    const stored = migrateModelManagementDocument(DEFAULT_SETTINGS, 'before-refresh', new Date())
    delete stored.builtinCatalogVersion
    const connection = stored.connections.find(item => item.providerId === 'openai')!
    connection.protocol = 'openai-chat'
    connection.baseUrl = 'https://saved.example/v1'
    const oldModel = stored.models.find(item => item.connectionId === connection.id)!
    oldModel.id = 'model:openai:gpt-4o'
    oldModel.modelId = 'gpt-4o'
    oldModel.name = 'My saved GPT-4o'
    oldModel.baseline.api = 'openai-completions'
    oldModel.manualOverrides = { contextWindow: 64000, maxTokens: 2048 }
    const sharedId = stored.models.find(item => item.modelId === 'gpt-6.1-sol')!
    sharedId.name = 'My Sol'
    stored.assignments[0]!.model = { mode: 'explicit', modelRef: oldModel.id }
    stored.assignments[1]!.model = { mode: 'explicit', modelRef: sharedId.id }
    const { module, store, credentials } = harness({ stored })
    const refreshed = module.read()
    const saved = store.value as ModelManagementDocument
    assert.equal(saved.builtinCatalogVersion, BUILT_IN_LLM_CATALOG_VERSION)
    for (const original of stored.models) {
      assert.deepEqual(saved.models.find(item => item.id === original.id), {
        ...original, builtin: original.id === oldModel.id ? false : original.builtin
      })
    }
    assert.deepEqual(saved.connections, stored.connections)
    assert.deepEqual(saved.assignments, stored.assignments)
    assert.equal(credentials.writes, 0)
    assert.equal(saved.models.filter(item => item.connectionId === connection.id && item.modelId === sharedId.modelId).length, 1)
    assert.equal(module.resolve('app-default').model.modelId, 'gpt-4o')
    assert.equal(module.resolve('app-default').model.maxTokens, 2048)
    assert.equal(module.resolve('app-default').model.api, 'openai-completions')
    const newModel = refreshed.models.find(item => item.modelId === 'gpt-6-astra')!
    assert.equal(newModel.builtin, true)
    assert.equal(newModel.effective.api, 'openai-responses')
    assert.equal(store.writes, 1)
    module.read()
    assert.equal(store.writes, 1)
    const restarted = harness({ stored: store.value })
    assert.deepEqual(restarted.module.read(), refreshed)
    assert.equal(restarted.store.writes, 0)
  })

  it('deletes unused retired presets, preserves manual models and protects referenced retired presets', () => {
    const stored = migrateModelManagementDocument(DEFAULT_SETTINGS, 'old', new Date())
    stored.builtinCatalogVersion = BUILT_IN_LLM_CATALOG_VERSION - 1
    const template = structuredClone(stored.models[0]!)
    const bound = { ...structuredClone(template), id: 'retired-bound', modelId: 'retired-bound' }
    const unused = { ...structuredClone(template), id: 'retired-unused', modelId: 'retired-unused',
      manualOverrides: { maxTokens: 1234 } }
    const manual = { ...structuredClone(template), id: 'manual-unused', modelId: 'manual-unused', builtin: false }
    stored.models.push(bound, unused, manual)
    stored.assignments[1]!.model = { mode: 'explicit', modelRef: bound.id }
    const { module, store } = harness({ stored })
    const snapshot = module.read()
    assert.equal(snapshot.models.some(item => item.id === unused.id), false)
    assert.equal(snapshot.models.find(item => item.id === bound.id)!.builtin, false)
    assert.deepEqual((store.value as ModelManagementDocument).models.find(item => item.id === manual.id), manual)
    const boundRef = bound.id
    assert.throws(() => module.apply({ expectedRevision: snapshot.revision, command: {
      type: 'remove-model', modelRef: boundRef
    } }), /用途|使用|引用/)
    const after = module.apply({ expectedRevision: snapshot.revision, command: {
      type: 'remove-model', modelRef: manual.id
    } })
    assert.equal(after.models.some(item => item.id === manual.id), false)
    const restarted = harness({ stored: store.value })
    assert.equal(restarted.module.read().models.some(item => item.id === unused.id), false)
    assert.equal(restarted.module.read().models.some(item => item.id === manual.id), false)
    assert.equal(restarted.store.writes, 0)
  })

  it('does not cache a catalog refresh that failed to persist and retries without duplicates', () => {
    const stored = migrateModelManagementDocument(DEFAULT_SETTINGS, 'old', new Date())
    delete stored.builtinCatalogVersion
    stored.models = stored.models.filter(item => item.modelId !== 'gpt-6-astra')
    const { module, store } = harness({ stored })
    store.failWrite = true
    assert.throws(() => module.read(), /disk full/)
    assert.deepEqual(store.value, stored)
    store.failWrite = false
    const snapshot = module.read()
    assert.equal(snapshot.models.filter(item => item.modelId === 'gpt-6-astra').length, 1)
    assert.equal(snapshot.models.find(item => item.modelId === 'gpt-6.1-sol')!.builtin, true)
    assert.equal((store.value as ModelManagementDocument).builtinCatalogVersion, BUILT_IN_LLM_CATALOG_VERSION)
  })

  it('preserves a retired model selected in legacy settings as a manual model', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.defaultLlmProviderId = 'openai'
    settings.defaultLlmModelId = 'gpt-4o'
    settings.llmProviderConfigs.openai = { protocol: 'openai-chat' }
    const { module } = harness({ settings })
    const snapshot = module.read()
    const model = snapshot.models.find(item => item.modelId === 'gpt-4o')!
    assert.equal(model.builtin, false)
    assert.equal(assignment(snapshot, 'app-default').resolution.modelRef, model.id)
    assert.equal(module.resolve('app-default').model.api, 'openai-completions')
  })

  it('probes new OpenAI presets with their effective API without changing an existing connection', async () => {
    const stored = migrateModelManagementDocument(DEFAULT_SETTINGS, 'old', new Date())
    delete stored.builtinCatalogVersion
    stored.connections.find(item => item.providerId === 'openai')!.protocol = 'openai-chat'
    stored.models = stored.models.filter(item => item.modelId !== 'gpt-6-astra')
    const { module, transport } = harness({ stored })
    const snapshot = module.read()
    const model = snapshot.models.find(item => item.modelId === 'gpt-6-astra')!
    transport.test = async (config: ResolvedLlmModelRequestConfig) => {
      assert.equal(config.protocol, 'openai-responses')
      assert.equal(config.responsesUrl, 'https://api.openai.com/v1/responses')
      assert.equal(config.chatCompletionsUrl, undefined)
      assert.equal(config.modelId, 'gpt-6-astra')
      return 'JAVDEX_OK'
    }
    assert.equal((await module.testModel(model.id, new AbortController().signal)).sample, 'JAVDEX_OK')
    assert.equal(module.read().connections.find(item => item.providerId === 'openai')!.protocol, 'openai-chat')
  })

  it('adds new cloud presets to saved documents once without changing existing choices', () => {
    const stored = migrateModelManagementDocument(DEFAULT_SETTINGS, 'saved-revision', new Date())
    stored.connections = stored.connections.filter(item => !['gemini', 'bailian'].includes(item.providerId))
    const ids = new Set(stored.connections.map(item => item.id))
    stored.models = stored.models.filter(item => ids.has(item.connectionId))
    stored.connections.find(item => item.providerId === 'openai')!.baseUrl = 'https://saved.example/v1'
    const { module, store } = harness({ stored })
    const snapshot = module.read()
    assert.equal(snapshot.connections.find(item => item.providerId === 'gemini')!.protocol, 'google-generative-ai')
    assert.equal(snapshot.connections.find(item => item.providerId === 'bailian')!.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
    assert.deepEqual((store.value as ModelManagementDocument).assignments, stored.assignments)
    assert.deepEqual((store.value as ModelManagementDocument).connections.filter(item => ids.has(item.id)), stored.connections)
    assert.equal(store.writes, 1)
    module.read()
    assert.equal(store.writes, 1)
    const restarted = harness({ stored: store.value })
    assert.equal(restarted.module.read().revision, snapshot.revision)
    assert.equal(restarted.store.writes, 0)
  })

  it('retains a custom Gemini endpoint and models when a shipped preset appears', () => {
    const stored = migrateModelManagementDocument(DEFAULT_SETTINGS, 'saved-revision', new Date())
    const connection = stored.connections.find(item => item.providerId === 'gemini')!
    connection.source = 'custom'
    connection.protocol = 'openai-chat'
    connection.baseUrl = 'https://gateway.example/v1'
    const { module, store } = harness({ stored })
    module.read()
    const saved = store.value as ModelManagementDocument
    assert.equal(saved.connections.find(item => item.id === connection.id)!.baseUrl, connection.baseUrl)
    assert.equal(saved.connections.find(item => item.id === connection.id)!.protocol, 'openai-chat')
    assert.deepEqual(saved.models, stored.models)
    assert.deepEqual(saved.assignments, stored.assignments)
  })

  for (const protocol of ['openai-responses', 'google-generative-ai'] as const) {
    it(`persists and resolves ${protocol} and sends the correct discovery/probe endpoints`, async () => {
      const { module, store, transport } = harness()
      const before = module.read()
      const snapshot = module.apply({ expectedRevision: before.revision, command: {
        type: 'save-connection', connection: {
          providerId: 'openai', name: 'OpenAI', source: 'builtin', protocol,
          baseUrl: protocol === 'google-generative-ai' ? 'https://google.example/v1beta' : 'https://responses.example/v1',
          apiKeyAction: 'keep'
        }
      } })
      const connection = snapshot.connections.find(item => item.providerId === 'openai')!
      const model = snapshot.models.find(item => item.connectionId === connection.id)!
      const selected = module.apply({ expectedRevision: snapshot.revision, command: { type: 'set-default-model', modelRef: model.id } })
      assert.equal(module.resolve('app-default').model.api, protocol)
      assert.deepEqual(module.read().assignments, selected.assignments)
      let discovered = false
      transport.discover = async config => {
        assert.equal(config.protocol, protocol)
        assert.equal(config.chatCompletionsUrl, undefined)
        if (protocol === 'google-generative-ai') assert.equal(config.googleModelsUrl, 'https://google.example/v1beta/models')
        else assert.equal(config.responsesUrl, 'https://responses.example/v1/responses')
        discovered = true
        return []
      }
      await module.discoverModels(connection.id, new AbortController().signal)
      assert.ok(discovered)
      assert.equal(harness({ stored: store.value }).module.read().connections.find(item => item.id === connection.id)!.protocol, protocol)
    })
  }

  it('builds the migration backup from a strict non-secret provider whitelist', () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as AppSettings & {
      llmProviderConfigs: Record<string, { baseUrl?: string; protocol?: string; apiKey?: string }>
    }
    settings.llmProviderConfigs = {
      openai: {
        baseUrl: 'https://user:password@api.example.test/v1?api_key=query-secret#fragment',
        protocol: 'openai-chat',
        apiKey: 'sk-must-not-enter-backup'
      }
    }

    const serialized = JSON.stringify(buildLegacyLlmSettingsBackup(settings))

    assert.equal(serialized.includes('sk-must-not-enter-backup'), false)
    assert.equal(serialized.includes('query-secret'), false)
    assert.equal(serialized.includes('password'), false)
    assert.match(serialized, /api\.example\.test/)
  })

  it('migrates released settings once and then reads the same current revision', () => {
    const { module, store } = harness()

    const first = module.read()
    const second = module.read()

    assert.equal(first.schemaVersion, 4)
    assert.equal(first.revision, 'revision-1')
    assert.equal(second.revision, first.revision)
    assert.equal(store.backups, 1)
    assert.equal(store.writes, 1)
    assert.equal(assignment(first, 'plugin-developer').model.mode, 'inherit-default')
    assert.equal(first.models[0]?.baseline.cache.evidence.source, 'migration')
  })

  it('fails closed for an invalid v2 document', () => {
    const { module, store } = harness({
      stored: {
        schemaVersion: 2,
        revision: 'bad',
        updatedAt: '2026-08-22T00:00:00.000Z',
        connections: [],
        models: [],
        assignments: []
      }
    })

    assert.throws(() => module.read(), /缺少用途配置/)
    assert.equal(store.writes, 0)
  })

  it('fails closed for malformed nested configuration and embedding catalog entries', () => {
    const valid = migrateModelManagementDocument(
      DEFAULT_SETTINGS,
      'valid-revision',
      new Date('2026-08-22T00:00:00.000Z')
    )
    const malformed = structuredClone(valid) as unknown as {
      models: Array<{ kind: string; baseline: { capabilities: { tools: unknown } } }>
      assignments: Array<{ runtime: { cacheRetention: string }; compaction: { reserveTokens: number } }>
    }
    malformed.models[0]!.baseline.capabilities.tools = 'yes'
    malformed.assignments[0]!.runtime.cacheRetention = 'forever'
    const malformedHarness = harness({ stored: malformed })

    assert.throws(() => malformedHarness.module.read(), /读取模型配置失败/)
    assert.equal(malformedHarness.store.writes, 0)

    const embedding = structuredClone(valid)
    embedding.models[0]!.kind = 'embedding'
    const embeddingHarness = harness({ stored: embedding })
    assert.throws(() => embeddingHarness.module.read(), /kind/)
    assert.equal(embeddingHarness.store.writes, 0)
  })

  it('saving a provider never changes workload assignments', () => {
    const { module } = harness()
    const before = module.read()
    const after = module.apply({
      expectedRevision: before.revision,
      command: {
        type: 'save-connection',
        connection: {
          providerId: 'deepseek',
          name: 'DeepSeek',
          source: 'builtin',
          protocol: 'openai-chat',
          baseUrl: 'https://proxy.example/v1',
          apiKeyAction: 'keep'
        }
      }
    })

    assert.deepEqual(
      after.assignments.map(({ resolution: _resolution, ...item }) => item),
      before.assignments.map(({ resolution: _resolution, ...item }) => item)
    )
  })

  it('refreshes protocol-derived model metadata when a connection contract changes', () => {
    const { module } = harness()
    let snapshot = module.read()
    const connection = snapshot.connections.find((item) => item.providerId === 'deepseek')!
    const target = snapshot.models.find((item) => item.connectionId === connection.id)!
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'save-connection',
        connection: {
          providerId: 'deepseek',
          name: 'DeepSeek',
          source: 'builtin',
          protocol: 'anthropic-messages',
          baseUrl: 'https://api.deepseek.com',
          apiKeyAction: 'keep'
        }
      }
    })

    const updated = snapshot.models.find((item) => item.id === target.id)!
    assert.equal(updated.baseline.api, 'anthropic-messages')
    assert.equal(updated.baseline.cache.supportsPromptCache, 'unknown')
    assert.equal(updated.baseline.cache.supportsLongCacheRetention, false)
  })

  it('never exposes credentials or Base URL query secrets in renderer snapshots', () => {
    const { module } = harness()
    let snapshot = module.read()
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'save-connection',
        connection: {
          providerId: 'deepseek',
          name: 'DeepSeek',
          source: 'builtin',
          protocol: 'openai-chat',
          baseUrl: 'https://api.example.test/v1?api_key=secret#fragment',
          apiKeyAction: 'replace',
          apiKey: 'sk-never-render'
        }
      }
    })

    const serialized = JSON.stringify(snapshot)
    assert.equal(serialized.includes('credentialRef'), false)
    assert.equal(serialized.includes('sk-never-render'), false)
    assert.equal(serialized.includes('api_key'), false)
    assert.equal(
      snapshot.connections.find((item) => item.providerId === 'deepseek')?.baseUrl,
      'https://api.example.test/v1'
    )
  })

  it('changing the default affects inherited workloads but preserves an explicit plugin model', () => {
    const { module } = harness()
    let snapshot = module.read()
    const deepseekModels = snapshot.models.filter((model) =>
      snapshot.connections.find((connection) => connection.id === model.connectionId)?.providerId === 'deepseek'
    )
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'set-workload-assignment',
        workloadId: 'plugin-developer',
        model: { mode: 'explicit', modelRef: deepseekModels[1]!.id },
        runtime: assignment(snapshot, 'plugin-developer').runtime,

        limits: assignment(snapshot, 'plugin-developer').limits
      }
    })
    const openAiModel = snapshot.models.find((model) =>
      snapshot.connections.find((connection) => connection.id === model.connectionId)?.providerId === 'openai'
    )!
    const after = module.apply({
      expectedRevision: snapshot.revision,
      command: { type: 'set-default-model', modelRef: openAiModel.id }
    })

    assert.equal(assignment(after, 'app-default').resolution.modelRef, openAiModel.id)
    assert.equal(assignment(after, 'library-curator').resolution.modelRef, openAiModel.id)
    assert.equal(assignment(after, 'plugin-developer').resolution.modelRef, deepseekModels[1]!.id)
  })

  it('freezes the workload context limit into resolved model access', () => {
    const { module } = harness()
    let snapshot = module.read()
    const current = assignment(snapshot, 'plugin-developer')
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'set-workload-assignment',
        workloadId: 'plugin-developer',
        model: current.model,
        runtime: current.runtime,

        limits: { ...current.limits, maxContextTokens: 64_000 }
      }
    })

    assert.equal(snapshot.assignments.find(
      (item) => item.workloadId === 'plugin-developer'
    )?.limits.maxContextTokens, 64_000)
    assert.equal(module.resolve('plugin-developer').model.contextWindow, 64_000)
  })

  it('rejects removing an in-use model and reports the exact workload', () => {
    const { module, credentials } = harness()
    let snapshot = module.read()
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'save-connection',
        connection: {
          providerId: 'custom-test',
          name: 'Custom Test',
          source: 'custom',
          protocol: 'openai-chat',
          baseUrl: 'https://example.test/v1',
          apiKeyAction: 'replace',
          apiKey: 'sk-custom'
        }
      }
    })
    credentials.values.set('custom-test', 'sk-custom')
    const connection = snapshot.connections.find((item) => item.providerId === 'custom-test')!
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: { type: 'add-model', connectionId: connection.id, modelId: 'custom-chat', name: 'Custom Chat' }
    })
    const customModel = snapshot.models.find((item) => item.connectionId === connection.id)!
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'set-workload-assignment',
        workloadId: 'plugin-developer',
        model: { mode: 'explicit', modelRef: customModel.id },
        runtime: assignment(snapshot, 'plugin-developer').runtime,

        limits: assignment(snapshot, 'plugin-developer').limits
      }
    })

    assert.throws(
      () => module.apply({
        expectedRevision: snapshot.revision,
        command: { type: 'remove-model', modelRef: customModel.id }
      }),
      (error) => error instanceof ModelManagementError &&
        error.code === 'MODEL_IN_USE' &&
        error.usages?.join(',') === 'plugin-developer'
    )
  })

  it('restores the previous credential when configuration persistence fails', () => {
    const { module, store, credentials } = harness()
    const snapshot = module.read()
    store.failWrite = true

    assert.throws(() => module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'save-connection',
        connection: {
          providerId: 'deepseek',
          name: 'DeepSeek',
          source: 'builtin',
          protocol: 'openai-chat',
          baseUrl: 'https://api.deepseek.com',
          apiKeyAction: 'replace',
          apiKey: 'sk-new'
        }
      }
    }), /disk full/)
    assert.equal(credentials.read('deepseek'), 'sk-deepseek')
  })

  it('does not touch credentials or storage on a stale revision', () => {
    const { module, store, credentials } = harness()
    module.read()
    const writesBefore = credentials.writes
    const storeWritesBefore = store.writes

    assert.throws(
      () => module.apply({
        expectedRevision: 'stale',
        command: {
          type: 'save-connection',
          connection: {
            providerId: 'deepseek',
            name: 'DeepSeek',
            source: 'builtin',
            protocol: 'openai-chat',
            baseUrl: 'https://api.deepseek.com',
            apiKeyAction: 'clear'
          }
        }
      }),
      (error) => error instanceof ModelManagementError && error.code === 'REVISION_CONFLICT'
    )
    assert.equal(credentials.writes, writesBefore)
    assert.equal(store.writes, storeWritesBefore)
  })

  it('keeps discovery ephemeral and reset removes manual overrides', async () => {
    const { module, store, transport } = harness()
    let snapshot = module.read()
    const deepseek = snapshot.connections.find((item) => item.providerId === 'deepseek')!
    const writesBeforeDiscovery = store.writes
    const candidates = await module.discoverModels(deepseek.id, new AbortController().signal)
    assert.equal(candidates[0]?.id, 'remote-chat')
    assert.equal(transport.discoverCalls, 1)
    assert.equal(store.writes, writesBeforeDiscovery)

    const target = snapshot.models.find((item) => item.connectionId === deepseek.id)!
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'set-model-override',
        modelRef: target.id,
        patch: { contextWindow: 64_000 }
      }
    })
    assert.equal(snapshot.models.find((item) => item.id === target.id)?.effective.contextWindow, 64_000)
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: { type: 'reset-model-override', modelRef: target.id }
    })
    const reset = snapshot.models.find((item) => item.id === target.id)!
    assert.equal(reset.hasManualOverrides, false)
    assert.equal(reset.effective.contextWindow, reset.baseline.contextWindow)
  })

  it('rejects non-tool Agent models', () => {
    const { module } = harness()
    let snapshot = module.read()
    const target = snapshot.models.find((item) =>
      assignment(snapshot, 'plugin-developer').resolution.modelRef !== item.id
    )!
    snapshot = module.apply({
      expectedRevision: snapshot.revision,
      command: {
        type: 'set-model-override',
        modelRef: target.id,
        patch: { capabilities: { tools: false } }
      }
    })
    assert.throws(
      () => module.apply({
        expectedRevision: snapshot.revision,
        command: {
          type: 'set-workload-assignment',
          workloadId: 'plugin-developer',
          model: { mode: 'explicit', modelRef: target.id },
          runtime: assignment(snapshot, 'plugin-developer').runtime,

          limits: assignment(snapshot, 'plugin-developer').limits
        }
      }),
      (error) => error instanceof ModelManagementError && error.code === 'MODEL_NOT_TOOL_CAPABLE'
    )


  })
})

it('upgrades released schema 3 directly to 4 once while preserving connections and purpose bindings', () => {
  const current = migrateModelManagementDocument(DEFAULT_SETTINGS, 'released', new Date())
  const { builtinCatalogVersion: _catalog, ...released } = current
  const original = { ...released, schemaVersion: 3 }
  const { module, store, credentials } = harness({ stored: original })
  const state = module.read()
  assert.equal(state.schemaVersion, 4)
  const saved = store.value as ModelManagementDocument
  assert.equal(saved.builtinCatalogVersion, 1)
  assert.deepEqual(saved.connections, original.connections)
  assert.deepEqual(saved.models, original.models)
  assert.deepEqual(saved.assignments, original.assignments)
  assert.equal(store.writes, 1); assert.equal(credentials.writes, 0)
  const restarted = harness({ stored: saved })
  assert.equal(restarted.module.read().revision, saved.revision)
  assert.equal(restarted.store.writes, 0)
})

it('rejects unpublished schema 3 catalog extensions without rewriting the original document', () => {
  const original = { ...migrateModelManagementDocument(DEFAULT_SETTINGS, 'development', new Date()),
    schemaVersion: 3, builtinCatalogVersion: 20261011 }
  const { module, store } = harness({ stored: original })
  assert.throws(() => module.read(), /读取模型配置失败/)
  assert.deepEqual(store.value, original)
  assert.equal(store.writes, 0)
})

it('keeps a released schema 3 document untouched until its direct upgrade can be persisted', () => {
  const { builtinCatalogVersion: _catalog, ...released } = migrateModelManagementDocument(DEFAULT_SETTINGS, 'released', new Date())
  const original = { ...released, schemaVersion: 3 }
  const { module, store } = harness({ stored: original })
  store.failWrite = true
  assert.throws(() => module.read(), /disk full/)
  assert.deepEqual(store.value, original)
  store.failWrite = false
  assert.equal(module.read().schemaVersion, 4)
  assert.equal(store.writes, 2, 'one failed attempt and one successful atomic save')
})

it('migrates v2 policies once while retaining connections, model choices and user limits', () => {
  const initial = harness()
  initial.module.read()
  const current = initial.store.value as ModelManagementDocument
  const { builtinCatalogVersion: _catalog, ...released } = current
  const legacy = { ...released, schemaVersion: 2, assignments: current.assignments.map(item => ({
    ...item, runtime: { ...item.runtime, cacheRetention: 'long' },
    compaction: { enabled: false, reserveTokens: 123, keepRecentTokens: 456 }
  })) }
  const { module, store, credentials } = harness({ stored: legacy })
  const after = module.read()
  assert.equal(after.schemaVersion, 4)
  const migrated = store.value as ModelManagementDocument
  assert.deepEqual(migrated.connections, current.connections)
  assert.deepEqual(migrated.models, current.models)
  assert.deepEqual(migrated.assignments, current.assignments)
  assert.equal(credentials.writes, 0)
  assert.equal(store.writes, 1)
  module.read()
  assert.equal(store.writes, 1)
})

it('keeps the legacy model file unchanged if policy migration cannot be persisted', () => {
  const initial = harness()
  initial.module.read()
  const current = initial.store.value as ModelManagementDocument
  const { builtinCatalogVersion: _catalog, ...released } = current
  const legacy = { ...released, schemaVersion: 2, assignments: current.assignments.map(item => ({
    ...item, runtime: { ...item.runtime, cacheRetention: 'short' },
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 }
  })) }
  const { module, store } = harness({ stored: legacy })
  store.failWrite = true
  assert.throws(() => module.read(), /disk full/)
  assert.deepEqual(store.value, legacy)
  store.failWrite = false
  assert.equal(module.read().schemaVersion, 4)
})
