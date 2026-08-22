import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settingsTypes'
import type {
  ModelCandidate,
  ModelManagementDocument,
  ModelManagementSnapshot
} from '@shared/modelManagementTypes'
import type { AIConfigurationDocument } from '@shared/aiConfigurationTypes'
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

  backupLegacy(): void {
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

  async discover(): Promise<ModelCandidate[]> {
    this.discoverCalls += 1
    return structuredClone(this.candidates)
  }

  async test(): Promise<string> {
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

function legacyV2Fixture(): AIConfigurationDocument {
  const seed = migrateModelManagementDocument(
    DEFAULT_SETTINGS,
    undefined,
    'seed-revision',
    new Date('2026-08-21T00:00:00.000Z')
  )
  const selected = seed.models[0]!
  const connection = seed.connections.find((item) => item.id === selected.connectionId)!
  const preset = {
    id: 'preset:balanced',
    name: 'Balanced',
    thinkingLevel: 'medium' as const,
    maxTokens: 0,
    timeoutMs: 120_000,
    cacheRetention: 'short' as const
  }
  const roles = ['primary', 'verifier', 'summarizer'] as const
  const routes = roles.map((role) => ({
    id: `route:plugin-developer:${role}`,
    name: role,
    role,
    modelRecordId: selected.id,
    presetId: preset.id
  }))
  const profile = (
    id: string,
    definitionId: 'plugin-developer' | 'library-curator'
  ): AIConfigurationDocument['agentProfiles'][number] => ({
    id,
    name: definitionId,
    definitionId,
    routes: {
      primary: routes[0]!.id,
      verifier: routes[1]!.id,
      summarizer: routes[2]!.id
    },
    toolPackRefs: [],
    capabilityGrants: [],
    approvalRequiredEffects: [],
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }
  })
  return {
    schemaVersion: 2,
    revision: 'legacy-revision',
    updatedAt: '2026-08-21T00:00:00.000Z',
    modelConnections: [{
      id: connection.id,
      name: connection.name,
      providerId: connection.providerId,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      credentialRef: connection.credentialRef,
      enabled: true
    }],
    modelRecords: [{
      id: selected.id,
      connectionId: selected.connectionId,
      modelId: selected.modelId,
      name: selected.name,
      api: selected.baseline.api,
      contextWindow: selected.baseline.contextWindow,
      maxTokens: selected.baseline.maxTokens,
      capabilities: structuredClone(selected.baseline.capabilities),
      cache: structuredClone(selected.baseline.cache)
    }],
    modelPresets: [preset],
    routes,
    agentProfiles: [
      profile('profile:plugin-developer:default', 'plugin-developer'),
      profile('profile:library-curator:default', 'library-curator')
    ]
  }
}

describe('ModelManagementModule', () => {
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

  it('migrates v2 once and then reads the same v3 revision', () => {
    const legacy = legacyV2Fixture()
    const { module, store } = harness({ stored: legacy })

    const first = module.read()
    const second = module.read()

    assert.equal(first.schemaVersion, 3)
    assert.equal(first.revision, 'revision-1')
    assert.equal(second.revision, first.revision)
    assert.equal(store.backups, 1)
    assert.equal(store.writes, 1)
    assert.equal(assignment(first, 'plugin-developer').model.mode, 'inherit-default')
    assert.equal(first.models[0]?.baseline.cache.evidence.source, 'migration')
  })

  it('fails closed for an invalid v3 document', () => {
    const { module, store } = harness({
      stored: {
        schemaVersion: 3,
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

  it('fails closed for malformed nested v3 data and embedding catalog entries', () => {
    const valid = migrateModelManagementDocument(
      DEFAULT_SETTINGS,
      undefined,
      'valid-revision',
      new Date('2026-08-22T00:00:00.000Z')
    )
    const malformed = structuredClone(valid) as unknown as {
      models: Array<{ kind: string; baseline: { capabilities: { tools: unknown } } }>
      assignments: Array<{ runtime: { cacheRetention: string }; compaction: { reserveTokens: number } }>
    }
    malformed.models[0]!.baseline.capabilities.tools = 'yes'
    malformed.assignments[0]!.runtime.cacheRetention = 'forever'
    malformed.assignments[0]!.compaction.reserveTokens = -1
    const malformedHarness = harness({ stored: malformed })

    assert.throws(() => malformedHarness.module.read(), /读取模型配置失败/)
    assert.equal(malformedHarness.store.writes, 0)

    const embedding = structuredClone(valid)
    embedding.models[0]!.kind = 'embedding'
    const embeddingHarness = harness({ stored: embedding })
    assert.throws(() => embeddingHarness.module.read(), /kind/)
    assert.equal(embeddingHarness.store.writes, 0)
  })

  it('preserves v2-only connections, models and primary workload bindings', () => {
    const legacy = legacyV2Fixture()
    const modelId = 'model:legacy-only:chat'
    const connectionId = 'connection:legacy-only'
    legacy.modelConnections.push({
      id: connectionId,
      name: 'Legacy Only',
      providerId: 'legacy-only',
      protocol: 'anthropic-messages',
      baseUrl: 'https://legacy.example.test',
      proxyUrl: 'http://127.0.0.1:7890',
      credentialRef: 'legacy-credential-ref',
      enabled: false
    })
    legacy.modelRecords.push({
      id: modelId,
      connectionId,
      modelId: 'legacy-chat',
      name: 'Legacy Chat',
      api: 'anthropic-messages',
      contextWindow: 96_000,
      maxTokens: 12_000,
      capabilities: { tools: true, vision: false, reasoning: 'unknown' },
      cache: {
        supportsPromptCache: true,
        supportsLongCacheRetention: false,
        cacheControlFormat: 'anthropic',
        sendSessionAffinityHeaders: false,
        evidence: {
          source: 'probe',
          checkedAt: '2026-08-20T00:00:00.000Z',
          note: 'legacy evidence'
        }
      }
    })
    legacy.routes.push({
      id: 'route:plugin-developer:legacy-primary',
      name: 'legacy primary',
      role: 'primary',
      modelRecordId: modelId,
      presetId: 'preset:balanced'
    })
    legacy.agentProfiles.find((profile) => profile.definitionId === 'plugin-developer')!
      .routes.primary = 'route:plugin-developer:legacy-primary'

    const migrated = migrateModelManagementDocument(
      DEFAULT_SETTINGS,
      legacy,
      'migrated',
      new Date('2026-08-22T00:00:00.000Z')
    )
    const connection = migrated.connections.find((item) => item.id === connectionId)!
    const model = migrated.models.find((item) => item.id === modelId)!
    const plugin = migrated.assignments.find((item) => item.workloadId === 'plugin-developer')!

    assert.equal(connection.name, 'Legacy Only')
    assert.equal(connection.protocol, 'anthropic-messages')
    assert.equal(connection.baseUrl, 'https://legacy.example.test')
    assert.equal(connection.proxyUrl, 'http://127.0.0.1:7890')
    assert.equal(connection.credentialRef, 'llm-provider:legacy-only')
    assert.equal(connection.enabled, false)
    assert.equal(model.baseline.contextWindow, 96_000)
    assert.equal(model.baseline.cache.evidence.source, 'probe')
    assert.deepEqual(plugin.model, { mode: 'explicit', modelRef: modelId })
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
        compaction: assignment(snapshot, 'plugin-developer').compaction,
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
        compaction: current.compaction,
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
        compaction: assignment(snapshot, 'plugin-developer').compaction,
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

  it('rejects non-tool Agent models and unsupported long cache', () => {
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
          compaction: assignment(snapshot, 'plugin-developer').compaction,
          limits: assignment(snapshot, 'plugin-developer').limits
        }
      }),
      (error) => error instanceof ModelManagementError && error.code === 'MODEL_NOT_TOOL_CAPABLE'
    )

    assert.throws(
      () => module.apply({
        expectedRevision: snapshot.revision,
        command: {
          type: 'set-workload-assignment',
          workloadId: 'plugin-developer',
          model: assignment(snapshot, 'plugin-developer').model,
          runtime: { ...assignment(snapshot, 'plugin-developer').runtime, cacheRetention: 'long' },
          compaction: assignment(snapshot, 'plugin-developer').compaction,
          limits: assignment(snapshot, 'plugin-developer').limits
        }
      }),
      (error) => error instanceof ModelManagementError && error.code === 'LONG_CACHE_UNSUPPORTED'
    )
  })
})
