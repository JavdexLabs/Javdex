import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readTestUserDataPath } from '@shared/appIdentity'
import type {
  AIConfigurationDocument,
  AIConfigurationSnapshot,
  AIRoute,
  AgentProfile,
  ModelCacheCompatibility,
  ModelRecord
} from '@shared/aiConfigurationTypes'
import { buildLlmProviderViewModels, normalizeDefaultLlmSelection } from '@shared/llmProviders'
import type { AppSettings } from '@shared/settingsTypes'
import { getPublicLlmProviderConfigs, getSettings } from '../settings/settingsStore'

const CONFIG_FILE = 'ai-configuration.json'
let cache: AIConfigurationDocument | null = null

function userDataPath(): string {
  return readTestUserDataPath() ?? app.getPath('userData')
}

function filePath(): string {
  return path.join(userDataPath(), CONFIG_FILE)
}

function stableIdPart(value: string): string {
  return encodeURIComponent(value.trim()).replace(/%/g, '_').slice(0, 120)
}

function migratedCacheCompatibility(providerId: string, protocol: string): ModelCacheCompatibility {
  const checkedAt = new Date().toISOString()
  if (providerId === 'anthropic') {
    return {
      supportsPromptCache: true,
      supportsLongCacheRetention: true,
      cacheControlFormat: 'anthropic',
      sendSessionAffinityHeaders: false,
      evidence: { source: 'migration', checkedAt, note: 'Anthropic Messages 显式兼容配置' }
    }
  }
  if (protocol === 'anthropic-messages') {
    return {
      supportsPromptCache: 'unknown',
      supportsLongCacheRetention: false,
      sendSessionAffinityHeaders: false,
      evidence: { source: 'migration', checkedAt, note: '自定义 Anthropic-compatible 连接未提供缓存能力证据' }
    }
  }
  if (providerId === 'openai') {
    return {
      supportsPromptCache: true,
      supportsLongCacheRetention: true,
      sessionAffinityFormat: 'openai',
      sendSessionAffinityHeaders: true,
      evidence: { source: 'migration', checkedAt, note: 'OpenAI 显式兼容配置' }
    }
  }
  if (providerId === 'openrouter') {
    return {
      supportsPromptCache: true,
      supportsLongCacheRetention: false,
      sessionAffinityFormat: 'openrouter',
      sendSessionAffinityHeaders: true,
      evidence: { source: 'migration', checkedAt, note: 'OpenRouter 显式兼容配置' }
    }
  }
  return {
    supportsPromptCache: 'unknown',
    supportsLongCacheRetention: false,
    sendSessionAffinityHeaders: false,
    evidence: { source: 'migration', checkedAt, note: '旧配置未声明缓存能力，按未知处理' }
  }
}

function modelId(providerId: string, value: string): string {
  return `model:${stableIdPart(providerId)}:${stableIdPart(value)}`
}

function connectionId(providerId: string): string {
  return `connection:${stableIdPart(providerId)}`
}

export function createAIConfigurationFromLegacySettings(
  settings: AppSettings,
  revision: string = randomUUID()
): AIConfigurationDocument {
  const publicSettings = {
    ...settings,
    llmProviderConfigs: getPublicLlmProviderConfigs(settings)
  }
  const providers = buildLlmProviderViewModels(publicSettings)
  const selection = normalizeDefaultLlmSelection(publicSettings)
  const modelConnections = providers.map((provider) => ({
    id: connectionId(provider.id),
    name: provider.name,
    providerId: provider.id,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    credentialRef: `llm-provider:${provider.id}`,
    enabled: provider.status === 'ready'
  }))
  const modelRecords: ModelRecord[] = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: modelId(provider.id, model.id),
      connectionId: connectionId(provider.id),
      modelId: model.id,
      name: model.name,
      api: provider.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      contextWindow: 128_000,
      maxTokens: 16_384,
      capabilities: { tools: provider.agentCompatible, vision: 'unknown', reasoning: 'unknown' },
      cache: migratedCacheCompatibility(provider.id, provider.protocol)
    }))
  )
  const selectedModelId = selection.providerId && selection.modelId
    ? modelId(selection.providerId, selection.modelId)
    : modelRecords[0]?.id ?? ''
  const modelPresets = [
    {
      id: 'preset:balanced',
      name: '均衡',
      thinkingLevel: 'medium' as const,
      maxTokens: 8_192,
      timeoutMs: 120_000,
      cacheRetention: 'short' as const
    }
  ]
  const roles = ['primary', 'verifier', 'summarizer'] as const
  const routes: AIRoute[] = roles.map((role) => ({
    id: `route:plugin-developer:${role}`,
    name: role === 'primary' ? '插件开发主模型' : role === 'verifier' ? '插件验证模型' : '插件摘要模型',
    role,
    modelRecordId: selectedModelId,
    presetId: 'preset:balanced'
  }))
  const agentProfiles: AgentProfile[] = [
    {
      id: 'profile:plugin-developer:default',
      name: '插件开发（默认）',
      definitionId: 'plugin-developer',
      routes: {
        primary: 'route:plugin-developer:primary',
        verifier: 'route:plugin-developer:verifier',
        summarizer: 'route:plugin-developer:summarizer'
      },
      toolPackRefs: ['toolpack:plugin-developer:v1'],
      capabilityGrants: ['plugin.read', 'plugin.write', 'plugin.test', 'browser.read', 'browser.interact', 'plugin.install'],
      approvalRequiredEffects: ['install', 'credential-sensitive'],
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }
    },
    {
      id: 'profile:library-curator:default',
      name: '媒体库整理（架构验收）',
      definitionId: 'library-curator',
      routes: {
        primary: 'route:plugin-developer:primary',
        verifier: 'route:plugin-developer:verifier',
        summarizer: 'route:plugin-developer:summarizer'
      },
      toolPackRefs: ['toolpack:library-curator:v1'],
      capabilityGrants: ['library.read'],
      approvalRequiredEffects: [],
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }
    }
  ]
  return {
    schemaVersion: 2,
    revision,
    updatedAt: new Date().toISOString(),
    modelConnections,
    modelRecords,
    modelPresets,
    routes,
    agentProfiles
  }
}

function isDocument(value: unknown): value is AIConfigurationDocument {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<AIConfigurationDocument>
  return input.schemaVersion === 2 && typeof input.revision === 'string' &&
    Array.isArray(input.modelConnections) && Array.isArray(input.modelRecords) &&
    Array.isArray(input.modelPresets) && Array.isArray(input.routes) && Array.isArray(input.agentProfiles)
}

function persist(document: AIConfigurationDocument): void {
  const target = filePath()
  const temporary = `${target}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.writeFileSync(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, target)
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* preserve original error */ }
    throw new Error(`保存 AI 配置失败：${(error as Error).message}`)
  }
  cache = document
}

export function validateAIConfiguration(document: AIConfigurationDocument): string[] {
  const errors: string[] = []
  const unique = (kind: string, values: readonly string[]): void => {
    const seen = new Set<string>()
    for (const value of values) {
      if (!value.trim()) errors.push(`${kind} ID 不能为空`)
      else if (seen.has(value)) errors.push(`${kind} ID 重复：${value}`)
      seen.add(value)
    }
  }
  unique('Connection', document.modelConnections.map((item) => item.id))
  unique('Model', document.modelRecords.map((item) => item.id))
  unique('Preset', document.modelPresets.map((item) => item.id))
  unique('Route', document.routes.map((item) => item.id))
  unique('Agent Profile', document.agentProfiles.map((item) => item.id))
  const connections = new Set(document.modelConnections.map((item) => item.id))
  const models = new Map(document.modelRecords.map((item) => [item.id, item]))
  const presets = new Map(document.modelPresets.map((item) => [item.id, item]))
  const routes = new Map(document.routes.map((item) => [item.id, item]))
  for (const model of document.modelRecords) {
    if (!connections.has(model.connectionId)) errors.push(`Model ${model.id} 引用了不存在的 Connection`)
  }
  for (const route of document.routes) {
    if (!models.has(route.modelRecordId)) errors.push(`Route ${route.id} 引用了不存在的 Model`)
    if (!presets.has(route.presetId)) errors.push(`Route ${route.id} 引用了不存在的 Preset`)
    const preset = presets.get(route.presetId)
    const model = models.get(route.modelRecordId)
    if (preset?.cacheRetention === 'long' && !model?.cache.supportsLongCacheRetention) {
      errors.push(`Route ${route.id} 请求 long cache，但模型没有明确支持`)
    }
  }
  for (const profile of document.agentProfiles) {
    for (const role of ['primary', 'verifier', 'summarizer'] as const) {
      const route = routes.get(profile.routes[role])
      if (!route) errors.push(`Profile ${profile.id} 的 ${role} Route 不存在`)
      else if (route.role !== role) errors.push(`Profile ${profile.id} 的 ${role} Route 角色不匹配`)
    }
    const primary = routes.get(profile.routes.primary)
    const summarizer = routes.get(profile.routes.summarizer)
    if (primary && summarizer && primary.modelRecordId !== summarizer.modelRecordId) {
      errors.push(`Profile ${profile.id} 在 Pi 0.84.2 中必须让 primary 与 summarizer 使用同一模型`)
    }
  }
  return errors
}

export function getAIConfiguration(): AIConfigurationDocument {
  if (cache) return structuredClone(cache)
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as unknown
    if (!isDocument(parsed)) throw new Error('配置格式或版本无效')
    cache = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`读取 AI 配置失败：${(error as Error).message}`)
    }
    cache = createAIConfigurationFromLegacySettings(getSettings())
    persist(cache)
  }
  return structuredClone(cache)
}

export function getAIConfigurationSnapshot(): AIConfigurationSnapshot {
  const document = getAIConfiguration()
  return { ...document, validationErrors: validateAIConfiguration(document) }
}

export function saveAIConfiguration(
  expectedRevision: string,
  input: Omit<AIConfigurationDocument, 'revision' | 'updatedAt'>
): AIConfigurationSnapshot {
  const current = getAIConfiguration()
  if (current.revision !== expectedRevision) {
    throw new Error('AI 配置已被其他操作更新，请刷新后重试')
  }
  const next: AIConfigurationDocument = {
    ...structuredClone(input),
    schemaVersion: 2,
    revision: randomUUID(),
    updatedAt: new Date().toISOString()
  }
  const errors = validateAIConfiguration(next)
  if (errors.length > 0) throw new Error(errors.join('；'))
  persist(next)
  return { ...structuredClone(next), validationErrors: [] }
}

/** Keep the legacy provider editor usable while V2 is rolled into the settings UI. */
export function synchronizeAIConfigurationFromLegacySettings(settings: AppSettings): void {
  const current = getAIConfiguration()
  const migrated = createAIConfigurationFromLegacySettings(settings)
  const selected = migrated.routes.find((item) => item.role === 'primary')?.modelRecordId ?? ''
  const connectionsByProvider = new Map(current.modelConnections.map((item) => [item.providerId, item]))
  const modelByProviderAndId = new Map<string, ModelRecord>()
  for (const model of current.modelRecords) {
    const connection = current.modelConnections.find((item) => item.id === model.connectionId)
    if (connection) modelByProviderAndId.set(`${connection.providerId}\0${model.modelId}`, model)
  }
  const modelConnections = migrated.modelConnections.map((item) => ({
    ...item,
    id: connectionsByProvider.get(item.providerId)?.id ?? item.id
  }))
  const connectionIdByProvider = new Map(modelConnections.map((item) => [item.providerId, item.id]))
  const modelRecords = migrated.modelRecords.map((item) => {
    const migratedConnection = migrated.modelConnections.find((connection) => connection.id === item.connectionId)
    const providerId = migratedConnection?.providerId ?? ''
    const previous = modelByProviderAndId.get(`${providerId}\0${item.modelId}`)
    return {
      ...item,
      ...(previous ? { id: previous.id, cache: previous.cache, capabilities: previous.capabilities } : {}),
      connectionId: connectionIdByProvider.get(providerId) ?? item.connectionId
    }
  })
  const selectedMigratedModel = migrated.modelRecords.find((item) => item.id === selected)
  const selectedConnection = migrated.modelConnections.find((item) => item.id === selectedMigratedModel?.connectionId)
  const selectedCurrent = modelRecords.find((item) => {
    const connection = modelConnections.find((candidate) => candidate.id === item.connectionId)
    return connection?.providerId === selectedConnection?.providerId && item.modelId === selectedMigratedModel?.modelId
  })?.id ?? modelRecords[0]?.id ?? ''
  const next: AIConfigurationDocument = {
    ...current,
    revision: randomUUID(),
    updatedAt: new Date().toISOString(),
    modelConnections,
    modelRecords,
    routes: current.routes.map((route) => ({ ...route, modelRecordId: selectedCurrent }))
  }
  const errors = validateAIConfiguration(next)
  if (errors.length > 0) throw new Error(errors.join('；'))
  persist(next)
}

export function resetAIConfigurationRepositoryForTests(): void {
  cache = null
}
