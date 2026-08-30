import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { readTestUserDataPath } from '@shared/appIdentity'
import type { ModelCacheCompatibility } from '@shared/aiConfigurationTypes'
import {
  BUILT_IN_LLM_PROVIDER_BY_ID,
  buildLlmProviderViewModels,
  inferLlmModelKind,
  isReservedLlmProviderId,
  isValidCustomLlmProviderId,
  normalizeDefaultLlmSelection
} from '@shared/llmProviders'
import type { AppSettings } from '@shared/settingsTypes'
import {
  MODEL_MANAGEMENT_SCHEMA_VERSION,
  type ManagedModel,
  type ManagedModelConnection,
  type ManagedModelConnectionView,
  type ManagedModelView,
  type ManualModelOverrides,
  type ModelCandidate,
  type ModelManagementApplyInput,
  type ModelManagementCommand,
  type ModelManagementDocument,
  type ModelManagementErrorCode,
  type ModelManagementSnapshot,
  type ModelRuntimeMetadata,
  type ModelTestResult,
  type ModelWorkloadAssignment,
  type ModelWorkloadAssignmentView,
  type ModelWorkloadId,
  type SaveModelConnectionInput
} from '@shared/modelManagementTypes'
import { getPublicLlmProviderConfigs, getSettings } from '../settings/settingsStore'
import {
  deleteLlmApiKey,
  getLlmApiKey,
  hasLlmApiKey,
  saveLlmApiKeys
} from '../settings/llmSecretStore'
import {
  listResolvedLlmProviderModels,
  testResolvedLlmModelConnection
} from '../services/llmConnectionTest'
import type {
  ResolvedLlmModelRequestConfig,
  ResolvedLlmRequestConfig
} from '../services/llmClient'
import { llmFetch } from '../utils/llmFetch'
import type { CredentialLease, ResolvedModelAccess } from './types'

const CONFIG_FILE = 'ai-configuration.json'
const SETTINGS_BACKUP_FILE = 'settings.llm-v1.backup.json'
const MODEL_CONTEXT_DEFAULT = 128_000
const MODEL_OUTPUT_DEFAULT = 16_384
const LEASE_TTL_MS = 5 * 60 * 1000
const DEFAULT_COMPACTION = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }
const DEFAULT_RUNTIME = {
  thinkingLevel: 'medium' as const,
  maxTokens: 0,
  timeoutMs: 120_000,
  cacheRetention: 'short' as const
}

const safePositiveInteger = z.number().int().positive().refine(Number.isSafeInteger)
const safeNonNegativeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger)
const nonEmptyString = z.string().min(1)
const capabilityStateSchema = z.union([z.boolean(), z.literal('unknown')])
const probeEvidenceSchema = z.object({
  source: z.enum(['probe', 'manual', 'migration']),
  checkedAt: nonEmptyString,
  note: z.string().optional()
}).strict()
const cacheCompatibilitySchema = z.object({
  supportsPromptCache: capabilityStateSchema,
  supportsLongCacheRetention: z.boolean(),
  cacheControlFormat: z.literal('anthropic').optional(),
  sessionAffinityFormat: z.enum(['openai', 'openai-nosession', 'openrouter']).optional(),
  sendSessionAffinityHeaders: z.boolean(),
  evidence: probeEvidenceSchema
}).strict()
const capabilitiesSchema = z.object({
  tools: capabilityStateSchema,
  vision: capabilityStateSchema,
  reasoning: capabilityStateSchema
}).strict()
const runtimeMetadataSchema = z.object({
  api: z.enum(['openai-completions', 'anthropic-messages']),
  contextWindow: safePositiveInteger,
  maxTokens: safePositiveInteger,
  capabilities: capabilitiesSchema,
  cache: cacheCompatibilitySchema
}).strict()
const manualOverridesSchema = z.object({
  contextWindow: safePositiveInteger.optional(),
  maxTokens: safePositiveInteger.optional(),
  capabilities: capabilitiesSchema.partial().strict().optional(),
  cache: cacheCompatibilitySchema.omit({ evidence: true }).partial().extend({
    evidence: probeEvidenceSchema
  }).strict().optional()
}).strict()
const connectionSchema = z.object({
  id: nonEmptyString,
  providerId: nonEmptyString,
  name: nonEmptyString,
  source: z.enum(['builtin', 'custom']),
  protocol: z.enum(['openai-chat', 'anthropic-messages']),
  baseUrl: nonEmptyString,
  proxyUrl: z.string().optional(),
  credentialRef: nonEmptyString,
  local: z.boolean(),
  agentCompatible: z.boolean(),
  enabled: z.boolean()
}).strict()
const modelSchema = z.object({
  id: nonEmptyString,
  connectionId: nonEmptyString,
  modelId: nonEmptyString,
  name: nonEmptyString,
  kind: z.literal('chat'),
  builtin: z.boolean(),
  baseline: runtimeMetadataSchema,
  manualOverrides: manualOverridesSchema.optional()
}).strict()
const workloadSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit-default') }).strict(),
  z.object({ mode: z.literal('explicit'), modelRef: nonEmptyString }).strict()
])
const assignmentSchema = z.object({
  workloadId: z.enum(['app-default', 'plugin-developer', 'library-curator']),
  model: workloadSelectionSchema,
  runtime: z.object({
    thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']),
    maxTokens: safeNonNegativeInteger,
    timeoutMs: safePositiveInteger,
    cacheRetention: z.enum(['none', 'short', 'long'])
  }).strict(),
  compaction: z.object({
    enabled: z.boolean(),
    reserveTokens: safeNonNegativeInteger,
    keepRecentTokens: safeNonNegativeInteger
  }).strict(),
  limits: z.object({
    maxTurns: safeNonNegativeInteger,
    maxContextTokens: safePositiveInteger
  }).strict()
}).strict()
const modelManagementDocumentSchema = z.object({
  schemaVersion: z.literal(MODEL_MANAGEMENT_SCHEMA_VERSION),
  revision: nonEmptyString,
  updatedAt: nonEmptyString,
  connections: z.array(connectionSchema),
  models: z.array(modelSchema),
  assignments: z.array(assignmentSchema)
}).strict()

export interface ModelConfigurationStore {
  read(): unknown | null
  write(document: ModelManagementDocument): void
  backupLegacySettings(settings: AppSettings): void
}

export interface CredentialVaultPort {
  has(providerId: string): boolean
  read(providerId: string): string
  write(providerId: string, value: string): void
  remove(providerId: string): void
}

export interface ProviderTransportPort {
  discover(config: ResolvedLlmRequestConfig, signal: AbortSignal): Promise<ModelCandidate[]>
  test(
    config: ResolvedLlmModelRequestConfig,
    signal: AbortSignal
  ): Promise<string>
}

export interface ModelManagementDependencies {
  store: ModelConfigurationStore
  credentials: CredentialVaultPort
  providerTransport: ProviderTransportPort
  readLegacySettings(): AppSettings
  now(): Date
  nextRevision(): string
}

export class ModelManagementError extends Error {
  constructor(
    readonly code: ModelManagementErrorCode,
    message: string,
    readonly usages?: ModelWorkloadId[]
  ) {
    super(message)
    this.name = 'ModelManagementError'
  }
}

function stableIdPart(value: string): string {
  return encodeURIComponent(value.trim()).replace(/%/g, '_').slice(0, 120)
}

function connectionId(providerId: string): string {
  return `connection:${stableIdPart(providerId)}`
}

function modelRef(providerId: string, modelId: string): string {
  return `model:${stableIdPart(providerId)}:${stableIdPart(modelId)}`
}

function cacheCompatibility(
  providerId: string,
  protocol: string,
  checkedAt: string
): ModelCacheCompatibility {
  if (providerId === 'anthropic' && protocol === 'anthropic-messages') {
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
      evidence: { source: 'migration', checkedAt, note: 'Anthropic-compatible 连接未提供缓存证据' }
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
    evidence: { source: 'migration', checkedAt, note: '未声明缓存能力，按未知处理' }
  }
}

function defaultMetadata(
  providerId: string,
  protocol: 'openai-chat' | 'anthropic-messages',
  agentCompatible: boolean,
  checkedAt: string
): ModelRuntimeMetadata {
  return {
    api: protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
    contextWindow: MODEL_CONTEXT_DEFAULT,
    maxTokens: MODEL_OUTPUT_DEFAULT,
    capabilities: {
      tools: agentCompatible,
      vision: 'unknown',
      reasoning: 'unknown'
    },
    cache: cacheCompatibility(providerId, protocol, checkedAt)
  }
}

export function effectiveModelMetadata(model: ManagedModel): ModelRuntimeMetadata {
  const overrides = model.manualOverrides
  return {
    ...structuredClone(model.baseline),
    ...(overrides?.contextWindow !== undefined ? { contextWindow: overrides.contextWindow } : {}),
    ...(overrides?.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
    capabilities: {
      ...model.baseline.capabilities,
      ...overrides?.capabilities
    },
    cache: {
      ...model.baseline.cache,
      ...overrides?.cache,
      evidence: overrides?.cache?.evidence ?? model.baseline.cache.evidence
    }
  }
}

function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join('.') : 'document'
    return `${location}: ${issue.message}`
  })
}

function selectionForProviderModel(
  models: readonly ManagedModel[],
  connections: readonly ManagedModelConnection[],
  providerId: string,
  requestedModelId: string
): string | undefined {
  const connection = connections.find((item) => item.providerId === providerId)
  return models.find(
    (item) => item.connectionId === connection?.id && item.modelId === requestedModelId
  )?.id
}

function workloadAssignment(
  workloadId: Exclude<ModelWorkloadId, 'app-default'>,
  settings: AppSettings
): ModelWorkloadAssignment {
  return {
    workloadId,
    model: { mode: 'inherit-default' },
    runtime: { ...DEFAULT_RUNTIME },
    compaction: { ...DEFAULT_COMPACTION },
    limits: workloadId === 'plugin-developer'
      ? {
          maxTurns: settings.pluginDevAgentMaxTurns,
          maxContextTokens: settings.pluginDevAgentMaxContextTokens
        }
      : { maxTurns: 0, maxContextTokens: MODEL_CONTEXT_DEFAULT }
  }
}

export function migrateModelManagementDocument(
  settings: AppSettings,
  revision: string,
  now: Date
): ModelManagementDocument {
  const checkedAt = now.toISOString()
  const publicSettings = {
    ...settings,
    llmProviderConfigs: getPublicSettingsWithoutSecrets(settings)
  }
  const providers = buildLlmProviderViewModels(publicSettings)
  const connections: ManagedModelConnection[] = providers.map((provider) => ({
    id: connectionId(provider.id),
    providerId: provider.id,
    name: provider.name,
    source: provider.source,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    credentialRef: `llm-provider:${provider.id}`,
    local: provider.local,
    agentCompatible: provider.agentCompatible,
    enabled: true
  }))

  const models: ManagedModel[] = []
  for (const provider of providers) {
    const connection = connections.find((item) => item.providerId === provider.id)
    if (!connection) continue
    for (const model of provider.models) {
      if (inferLlmModelKind(model) !== 'chat') continue
      models.push({
        id: modelRef(provider.id, model.id),
        connectionId: connection.id,
        modelId: model.id,
        name: model.name,
        kind: 'chat',
        builtin: model.builtin === true,
        baseline: defaultMetadata(
          provider.id,
          connection.protocol,
          connection.agentCompatible,
          checkedAt
        )
      })
    }
  }
  const normalized = normalizeDefaultLlmSelection({
    ...settings,
    llmProviderConfigs: getPublicSettingsWithoutSecrets(settings)
  })
  const defaultRef = selectionForProviderModel(
    models,
    connections,
    settings.defaultLlmProviderId || normalized.providerId,
    settings.defaultLlmModelId || normalized.modelId
  ) ?? models[0]?.id ?? ''
  const assignments: ModelWorkloadAssignment[] = [
    {
      workloadId: 'app-default',
      model: { mode: 'explicit', modelRef: defaultRef },
      runtime: { ...DEFAULT_RUNTIME },
      compaction: { ...DEFAULT_COMPACTION, enabled: false },
      limits: { maxTurns: 0, maxContextTokens: MODEL_CONTEXT_DEFAULT }
    },
    workloadAssignment('plugin-developer', settings),
    workloadAssignment('library-curator', settings)
  ]
  return {
    schemaVersion: MODEL_MANAGEMENT_SCHEMA_VERSION,
    revision,
    updatedAt: checkedAt,
    connections,
    models,
    assignments
  }
}

function getPublicSettingsWithoutSecrets(
  settings: AppSettings
): ReturnType<typeof getPublicLlmProviderConfigs> {
  return Object.fromEntries(
    Object.entries(settings.llmProviderConfigs).map(([id, config]) => [
      id,
      {
        ...(typeof config.baseUrl === 'string' ? { baseUrl: config.baseUrl } : {}),
        ...(config.protocol === 'openai-chat' || config.protocol === 'anthropic-messages'
          ? { protocol: config.protocol }
          : {}),
        hasApiKey: false
      }
    ])
  )
}

export function buildLegacyLlmSettingsBackup(settings: AppSettings): Record<string, unknown> {
  const providerConfigs = Object.fromEntries(
    Object.entries(getPublicSettingsWithoutSecrets(settings)).map(([providerId, config]) => [
      providerId,
      {
        ...config,
        ...(config.baseUrl ? { baseUrl: rendererSafeBaseUrl(config.baseUrl) } : {})
      }
    ])
  )
  return {
    defaultLlmProviderId: settings.defaultLlmProviderId,
    defaultLlmModelId: settings.defaultLlmModelId,
    llmProviderConfigs: providerConfigs,
    customLlmProviders: settings.customLlmProviders.map((provider) => ({
      ...structuredClone(provider),
      baseUrl: rendererSafeBaseUrl(provider.baseUrl)
    })),
    llmCustomModels: structuredClone(settings.llmCustomModels),
    pluginDevAgentMaxTurns: settings.pluginDevAgentMaxTurns,
    pluginDevAgentMaxContextTokens: settings.pluginDevAgentMaxContextTokens
  }
}

export function validateModelManagementDocument(document: ModelManagementDocument): string[] {
  const structural = modelManagementDocumentSchema.safeParse(document)
  if (!structural.success) return formatSchemaIssues(structural.error)
  document = structural.data as ModelManagementDocument
  const errors: string[] = []
  const unique = (label: string, values: readonly string[]): void => {
    const seen = new Set<string>()
    for (const value of values) {
      if (!value.trim()) errors.push(`${label} ID 不能为空`)
      else if (seen.has(value)) errors.push(`${label} ID 重复：${value}`)
      seen.add(value)
    }
  }
  unique('Connection', document.connections.map((item) => item.id))
  unique('Provider', document.connections.map((item) => item.providerId))
  unique('Model', document.models.map((item) => item.id))
  unique('Connection model', document.models.map((item) => `${item.connectionId}\0${item.modelId}`))
  unique('Workload', document.assignments.map((item) => item.workloadId))
  const connections = new Set(document.connections.map((item) => item.id))
  const models = new Map(document.models.map((item) => [item.id, item]))
  for (const model of document.models) {
    if (!connections.has(model.connectionId)) errors.push(`Model ${model.id} 引用了不存在的 Connection`)
    if (model.kind !== 'chat') errors.push(`Model ${model.id} 不是生成模型`)
    const effective = effectiveModelMetadata(model)
    if (!Number.isSafeInteger(effective.contextWindow) || effective.contextWindow <= 0) {
      errors.push(`Model ${model.id} 的 contextWindow 必须是正整数`)
    }
    if (!Number.isSafeInteger(effective.maxTokens) || effective.maxTokens <= 0) {
      errors.push(`Model ${model.id} 的 maxTokens 必须是正整数`)
    }
  }
  for (const connection of document.connections) {
    if (connection.credentialRef !== `llm-provider:${connection.providerId}`) {
      errors.push(`Connection ${connection.id} 的 credentialRef 与 providerId 不一致`)
    }
    try {
      const url = new URL(connection.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
      if (url.username || url.password) errors.push(`Connection ${connection.id} 的 Base URL 不能包含凭据`)
    } catch {
      errors.push(`Connection ${connection.id} 的 Base URL 必须是 HTTP(S) URL`)
    }
    const builtIn = BUILT_IN_LLM_PROVIDER_BY_ID.has(connection.providerId)
    if (builtIn !== (connection.source === 'builtin')) {
      errors.push(`Connection ${connection.id} 的来源与 providerId 不一致`)
    }
  }
  const requiredWorkloads: ModelWorkloadId[] = ['app-default', 'plugin-developer', 'library-curator']
  for (const workloadId of requiredWorkloads) {
    if (!document.assignments.some((item) => item.workloadId === workloadId)) {
      errors.push(`缺少用途配置：${workloadId}`)
    }
  }
  for (const assignment of document.assignments) {
    if (assignment.workloadId === 'app-default' && assignment.model.mode !== 'explicit') {
      errors.push('app-default 必须显式选择模型')
    }
    if (assignment.model.mode === 'explicit' && !models.has(assignment.model.modelRef)) {
      errors.push(`用途 ${assignment.workloadId} 引用了不存在的模型`)
    }
    if (!Number.isSafeInteger(assignment.runtime.maxTokens) || assignment.runtime.maxTokens < 0) {
      errors.push(`用途 ${assignment.workloadId} 的 maxTokens 必须是非负整数`)
    }
    if (!Number.isSafeInteger(assignment.runtime.timeoutMs) || assignment.runtime.timeoutMs <= 0) {
      errors.push(`用途 ${assignment.workloadId} 的 timeoutMs 必须是正整数`)
    }
    if (!Number.isSafeInteger(assignment.limits.maxTurns) || assignment.limits.maxTurns < 0) {
      errors.push(`用途 ${assignment.workloadId} 的 maxTurns 必须是非负整数`)
    }
    if (!Number.isSafeInteger(assignment.limits.maxContextTokens) || assignment.limits.maxContextTokens <= 0) {
      errors.push(`用途 ${assignment.workloadId} 的 maxContextTokens 必须是正整数`)
    }
    if (!Number.isSafeInteger(assignment.compaction.reserveTokens) || assignment.compaction.reserveTokens < 0) {
      errors.push(`用途 ${assignment.workloadId} 的 reserveTokens 必须是非负整数`)
    }
    if (!Number.isSafeInteger(assignment.compaction.keepRecentTokens) || assignment.compaction.keepRecentTokens < 0) {
      errors.push(`用途 ${assignment.workloadId} 的 keepRecentTokens 必须是非负整数`)
    }
  }
  return errors
}

function workloadUsages(
  document: ModelManagementDocument,
  targetModelRef: string
): ModelWorkloadId[] {
  const defaultAssignment = document.assignments.find((item) => item.workloadId === 'app-default')
  const defaultRef = defaultAssignment?.model.mode === 'explicit'
    ? defaultAssignment.model.modelRef
    : ''
  return document.assignments
    .filter((assignment) => {
      const resolved = assignment.model.mode === 'explicit' ? assignment.model.modelRef : defaultRef
      return resolved === targetModelRef
    })
    .map((assignment) => assignment.workloadId)
}

function mergeOverrides(
  current: ManualModelOverrides | undefined,
  patch: ManualModelOverrides
): ManualModelOverrides {
  return {
    ...current,
    ...patch,
    capabilities: { ...current?.capabilities, ...patch.capabilities },
    ...(patch.cache ? { cache: { ...current?.cache, ...patch.cache } } : {})
  }
}

function endpoint(baseUrl: string, suffix: string, ensureV1 = false): string {
  const root = baseUrl.replace(/\/+$/, '')
  if (ensureV1 && !root.endsWith('/v1')) return `${root}/v1/${suffix}`
  return `${root}/${suffix}`
}

function rendererSafeBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value.split(/[?#]/, 1)[0] ?? ''
  }
}

export class ModelManagementModule {
  private cache: ModelManagementDocument | null = null

  constructor(private readonly dependencies: ModelManagementDependencies) {}

  read(): ModelManagementSnapshot {
    return this.snapshot(this.document())
  }

  apply(input: ModelManagementApplyInput): ModelManagementSnapshot {
    const current = this.document()
    if (input.expectedRevision !== current.revision) {
      throw new ModelManagementError(
        'REVISION_CONFLICT',
        '模型配置已被其他操作更新，请刷新后重试'
      )
    }
    const next = structuredClone(current)
    const credentialMutation = this.mutate(next, input.command)
    const errors = validateModelManagementDocument(next)
    if (errors.length > 0) {
      throw new ModelManagementError('VALIDATION_FAILED', errors.join('；'))
    }
    const previousSecret = credentialMutation
      ? this.dependencies.credentials.read(credentialMutation.providerId)
      : ''
    try {
      if (credentialMutation) this.applyCredentialMutation(credentialMutation)
      for (const workloadId of this.affectedWorkloads(next, input.command)) {
        this.assertWorkloadReady(next, workloadId)
      }
      next.revision = this.dependencies.nextRevision()
      next.updatedAt = this.dependencies.now().toISOString()
      this.dependencies.store.write(next)
      this.cache = structuredClone(next)
      return this.snapshot(next)
    } catch (error) {
      if (credentialMutation) {
        try {
          if (previousSecret) {
            this.dependencies.credentials.write(credentialMutation.providerId, previousSecret)
          } else {
            this.dependencies.credentials.remove(credentialMutation.providerId)
          }
        } catch (rollbackError) {
          throw new ModelManagementError(
            'MODEL_CONFIG_PARTIAL_WRITE',
            `${(error as Error).message}；恢复模型凭据失败：${(rollbackError as Error).message}`
          )
        }
      }
      throw error
    }
  }

  async discoverModels(connectionIdValue: string, signal: AbortSignal): Promise<ModelCandidate[]> {
    const connection = this.connection(this.document(), connectionIdValue)
    const config = this.providerRequestConfig(connection)
    return this.dependencies.providerTransport.discover(config, signal)
  }

  async testModel(modelRefValue: string, signal: AbortSignal): Promise<ModelTestResult> {
    const document = this.document()
    const model = this.model(document, modelRefValue)
    if (model.kind !== 'chat') throw new Error('嵌入模型不能执行生成测试')
    const connection = this.connection(document, model.connectionId)
    const config = {
      ...this.providerRequestConfig(connection),
      modelId: model.modelId,
      signal
    }
    const sample = await this.dependencies.providerTransport.test(config, signal)
    return { modelRef: model.id, sample }
  }

  resolve(workloadId: ModelWorkloadId): ResolvedModelAccess {
    const document = this.document()
    const { assignment, model, connection, effective } = this.assertWorkloadReady(document, workloadId)
    const maxTokens = assignment.runtime.maxTokens === 0
      ? effective.maxTokens
      : Math.min(effective.maxTokens, assignment.runtime.maxTokens)
    const contextWindow = Math.min(effective.contextWindow, assignment.limits.maxContextTokens)
    return {
      credentialRef: connection.credentialRef,
      model: {
        providerId: connection.providerId,
        modelId: model.modelId,
        name: model.name,
        api: effective.api,
        baseUrl: connection.baseUrl,
        contextWindow,
        maxTokens,
        reasoning: effective.capabilities.reasoning === true
      },
      routeRevision: `${document.revision}:${workloadId}`,
      preset: {
        thinkingLevel: assignment.runtime.thinkingLevel,
        maxTokens,
        timeoutMs: assignment.runtime.timeoutMs,
        cacheRetention: assignment.runtime.cacheRetention
      },
      cacheCompatibility: structuredClone(effective.cache),
      getCredentialLease: async () => this.issueCredentialLease(connection),
      fetch: llmFetch
    }
  }

  private document(): ModelManagementDocument {
    if (this.cache) return structuredClone(this.cache)
    const raw = this.dependencies.store.read()
    if (raw !== null) {
      const parsed = modelManagementDocumentSchema.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`读取模型配置失败：${formatSchemaIssues(parsed.error).join('；')}`)
      }
      const document = parsed.data as ModelManagementDocument
      const errors = validateModelManagementDocument(document)
      if (errors.length > 0) throw new Error(`读取模型配置失败：${errors.join('；')}`)
      this.cache = structuredClone(document)
      return structuredClone(document)
    }
    const settings = this.dependencies.readLegacySettings()
    const migrated = migrateModelManagementDocument(
      settings,
      this.dependencies.nextRevision(),
      this.dependencies.now()
    )
    const errors = validateModelManagementDocument(migrated)
    if (errors.length > 0) throw new Error(`迁移模型配置失败：${errors.join('；')}`)
    this.dependencies.store.backupLegacySettings(settings)
    this.dependencies.store.write(migrated)
    this.cache = structuredClone(migrated)
    return structuredClone(migrated)
  }

  private snapshot(document: ModelManagementDocument): ModelManagementSnapshot {
    const connections: ManagedModelConnectionView[] = document.connections.map((connection) => {
      const modelCount = document.models.filter(
        (model) => model.connectionId === connection.id && model.kind === 'chat'
      ).length
      const hasCredential = connection.local || this.dependencies.credentials.has(connection.providerId)
      const { credentialRef: _credentialRef, proxyUrl: _proxyUrl, ...publicConnection } = connection
      return {
        ...structuredClone(publicConnection),
        baseUrl: rendererSafeBaseUrl(connection.baseUrl),
        hasCredential,
        modelCount,
        status: !connection.enabled
          ? 'disabled'
          : hasCredential && modelCount > 0
            ? 'ready'
            : 'unconfigured'
      }
    })
    const models: ManagedModelView[] = document.models.map((model) => ({
      ...structuredClone(model),
      effective: effectiveModelMetadata(model),
      hasManualOverrides: model.manualOverrides !== undefined
    }))
    const assignments: ModelWorkloadAssignmentView[] = document.assignments.map((assignment) => ({
      ...structuredClone(assignment),
      resolution: this.workloadResolution(document, assignment.workloadId)
    }))
    return {
      schemaVersion: MODEL_MANAGEMENT_SCHEMA_VERSION,
      revision: document.revision,
      updatedAt: document.updatedAt,
      connections,
      models,
      assignments,
      validationErrors: validateModelManagementDocument(document)
    }
  }

  private workloadResolution(
    document: ModelManagementDocument,
    workloadId: ModelWorkloadId
  ): ModelWorkloadAssignmentView['resolution'] {
    try {
      const { model, connection } = this.assertWorkloadReady(document, workloadId)
      return {
        ready: true,
        modelRef: model.id,
        providerName: connection.name,
        modelName: model.name
      }
    } catch (error) {
      const assignment = document.assignments.find((item) => item.workloadId === workloadId)
      const selectedRef = assignment?.model.mode === 'explicit'
        ? assignment.model.modelRef
        : document.assignments.find((item) => item.workloadId === 'app-default')?.model.mode === 'explicit'
          ? (document.assignments.find((item) => item.workloadId === 'app-default')!.model as { mode: 'explicit'; modelRef: string }).modelRef
          : undefined
      const model = document.models.find((item) => item.id === selectedRef)
      const connection = document.connections.find((item) => item.id === model?.connectionId)
      return {
        ready: false,
        ...(model ? { modelRef: model.id, modelName: model.name } : {}),
        ...(connection ? { providerName: connection.name } : {}),
        reason: (error as Error).message
      }
    }
  }

  private assertWorkloadReady(document: ModelManagementDocument, workloadId: ModelWorkloadId) {
    const assignment = document.assignments.find((item) => item.workloadId === workloadId)
    if (!assignment) throw new ModelManagementError('VALIDATION_FAILED', `缺少用途配置：${workloadId}`)
    const defaultAssignment = document.assignments.find((item) => item.workloadId === 'app-default')
    const selectedRef = assignment.model.mode === 'explicit'
      ? assignment.model.modelRef
      : defaultAssignment?.model.mode === 'explicit'
        ? defaultAssignment.model.modelRef
        : ''
    const model = document.models.find((item) => item.id === selectedRef)
    if (!model) throw new ModelManagementError('VALIDATION_FAILED', `用途 ${workloadId} 没有可用模型`)
    if (model.kind !== 'chat') {
      throw new ModelManagementError('VALIDATION_FAILED', `模型「${model.name}」不是生成模型`)
    }
    const connection = this.connection(document, model.connectionId)
    if (!connection.enabled || (!connection.local && !this.dependencies.credentials.has(connection.providerId))) {
      throw new ModelManagementError(
        'CONNECTION_NOT_READY',
        `模型提供商「${connection.name}」尚未配置完成`
      )
    }
    const effective = effectiveModelMetadata(model)
    if (workloadId !== 'app-default' && effective.capabilities.tools !== true) {
      throw new ModelManagementError(
        'MODEL_NOT_TOOL_CAPABLE',
        `模型「${model.name}」没有明确的工具调用能力`
      )
    }
    if (assignment.runtime.cacheRetention === 'long' && !effective.cache.supportsLongCacheRetention) {
      throw new ModelManagementError(
        'LONG_CACHE_UNSUPPORTED',
        `模型「${model.name}」没有明确支持长期缓存`
      )
    }
    return { assignment, model, connection, effective }
  }

  private mutate(
    document: ModelManagementDocument,
    command: ModelManagementCommand
  ): { providerId: string; action: 'keep' | 'replace' | 'clear'; value?: string } | undefined {
    if (command.type === 'set-default-model') {
      const model = this.model(document, command.modelRef)
      if (model.kind !== 'chat') {
        throw new ModelManagementError('VALIDATION_FAILED', '默认用途只能选择生成模型')
      }
      const target = document.assignments.find((item) => item.workloadId === 'app-default')!
      target.model = { mode: 'explicit', modelRef: command.modelRef }
      return undefined
    }
    if (command.type === 'set-workload-assignment') {
      if (command.model.mode === 'explicit') {
        const model = this.model(document, command.model.modelRef)
        if (model.kind !== 'chat') {
          throw new ModelManagementError('VALIDATION_FAILED', 'Agent 用途只能选择生成模型')
        }
      }
      const target = document.assignments.find((item) => item.workloadId === command.workloadId)!
      target.model = structuredClone(command.model)
      target.runtime = structuredClone(command.runtime)
      target.compaction = structuredClone(command.compaction)
      target.limits = structuredClone(command.limits)
      return undefined
    }
    if (command.type === 'save-connection') {
      const input = command.connection
      this.validateConnectionInput(input)
      const builtIn = BUILT_IN_LLM_PROVIDER_BY_ID.get(input.providerId)
      const existing = document.connections.find((item) => item.providerId === input.providerId)
      const previousProtocol = existing?.protocol
      const previousAgentCompatible = existing?.agentCompatible
      const next: ManagedModelConnection = {
        id: existing?.id ?? connectionId(input.providerId),
        providerId: input.providerId,
        name: builtIn?.name ?? input.name.trim(),
        source: builtIn ? 'builtin' : 'custom',
        protocol: input.protocol,
        baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
        credentialRef: `llm-provider:${input.providerId}`,
        local: builtIn?.local === true || input.local === true,
        agentCompatible: builtIn?.agentCompatible ?? input.agentCompatible !== false,
        enabled: input.enabled !== false
      }
      if (existing) Object.assign(existing, next)
      else document.connections.push(next)
      const connectionContractChanged = !existing ||
        previousProtocol !== next.protocol ||
        previousAgentCompatible !== next.agentCompatible
      if (connectionContractChanged) {
        for (const model of document.models.filter((item) => item.connectionId === next.id)) {
          model.baseline.api = next.protocol === 'anthropic-messages'
            ? 'anthropic-messages'
            : 'openai-completions'
          model.baseline.capabilities.tools = next.agentCompatible
          model.baseline.cache = cacheCompatibility(
            next.providerId,
            next.protocol,
            this.dependencies.now().toISOString()
          )
        }
      }
      if (input.apiKeyAction === 'keep') return undefined
      return {
        providerId: input.providerId,
        action: input.apiKeyAction,
        ...(input.apiKey?.trim() ? { value: input.apiKey.trim() } : {})
      }
    }
    if (command.type === 'remove-connection') {
      const connection = this.connection(document, command.connectionId)
      if (connection.source === 'builtin') {
        throw new ModelManagementError('VALIDATION_FAILED', '内置模型提供商不能删除')
      }
      const modelIds = new Set(
        document.models.filter((item) => item.connectionId === connection.id).map((item) => item.id)
      )
      const usages = Array.from(modelIds).flatMap((id) => workloadUsages(document, id))
      if (usages.length > 0) {
        throw new ModelManagementError(
          'CONNECTION_IN_USE',
          `模型提供商「${connection.name}」仍被用途使用`,
          Array.from(new Set(usages))
        )
      }
      document.models = document.models.filter((item) => item.connectionId !== connection.id)
      document.connections = document.connections.filter((item) => item.id !== connection.id)
      return { providerId: connection.providerId, action: 'clear' }
    }
    if (command.type === 'add-model') {
      const connection = this.connection(document, command.connectionId)
      const id = command.modelId.trim()
      const name = command.name.trim() || id
      if (!id) throw new ModelManagementError('VALIDATION_FAILED', '模型 ID 不能为空')
      if (inferLlmModelKind({ id, name }) !== 'chat') {
        throw new ModelManagementError('VALIDATION_FAILED', '嵌入模型不能加入生成模型目录')
      }
      if (document.models.some((item) => item.connectionId === connection.id && item.modelId === id)) {
        throw new ModelManagementError('VALIDATION_FAILED', '模型 ID 已存在')
      }
      document.models.push({
        id: modelRef(connection.providerId, id),
        connectionId: connection.id,
        modelId: id,
        name,
        kind: 'chat',
        builtin: false,
        baseline: defaultMetadata(
          connection.providerId,
          connection.protocol,
          connection.agentCompatible,
          this.dependencies.now().toISOString()
        )
      })
      return undefined
    }
    if (command.type === 'remove-model') {
      const model = this.model(document, command.modelRef)
      if (model.builtin) throw new ModelManagementError('VALIDATION_FAILED', '内置模型不能删除')
      const usages = workloadUsages(document, model.id)
      if (usages.length > 0) {
        throw new ModelManagementError(
          'MODEL_IN_USE',
          `模型「${model.name}」仍被用途使用`,
          usages
        )
      }
      document.models = document.models.filter((item) => item.id !== model.id)
      return undefined
    }
    const model = this.model(document, command.modelRef)
    if (command.type === 'set-model-override') {
      model.manualOverrides = mergeOverrides(model.manualOverrides, command.patch)
    } else {
      delete model.manualOverrides
    }
    return undefined
  }

  private affectedWorkloads(
    document: ModelManagementDocument,
    command: ModelManagementCommand
  ): ModelWorkloadId[] {
    if (command.type === 'set-default-model') {
      return document.assignments
        .filter((item) => item.workloadId === 'app-default' || item.model.mode === 'inherit-default')
        .map((item) => item.workloadId)
    }
    if (command.type === 'set-workload-assignment') return [command.workloadId]
    if (command.type === 'save-connection') {
      const connection = document.connections.find((item) => item.providerId === command.connection.providerId)
      if (!connection) return []
      return document.models
        .filter((item) => item.connectionId === connection.id)
        .flatMap((item) => workloadUsages(document, item.id))
    }
    if (command.type === 'set-model-override' || command.type === 'reset-model-override') {
      return workloadUsages(document, command.modelRef)
    }
    return []
  }

  private validateConnectionInput(input: SaveModelConnectionInput): void {
    const providerId = input.providerId.trim()
    if (!providerId || !input.baseUrl.trim()) {
      throw new ModelManagementError('VALIDATION_FAILED', '提供商 ID 和 Base URL 不能为空')
    }
    try {
      const url = new URL(input.baseUrl.trim())
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
      if (url.username || url.password) {
        throw new ModelManagementError('VALIDATION_FAILED', 'Base URL 不能包含用户名或密码')
      }
    } catch (error) {
      if (error instanceof ModelManagementError) throw error
      throw new ModelManagementError('VALIDATION_FAILED', 'Base URL 必须是有效的 HTTP(S) URL')
    }
    const builtIn = BUILT_IN_LLM_PROVIDER_BY_ID.get(providerId)
    if (builtIn && input.source !== 'builtin') {
      throw new ModelManagementError('VALIDATION_FAILED', '内置提供商来源无效')
    }
    if (!builtIn && (isReservedLlmProviderId(providerId) || !isValidCustomLlmProviderId(providerId))) {
      throw new ModelManagementError('VALIDATION_FAILED', '自定义提供商 ID 格式无效')
    }
    if (!builtIn && (!input.name.trim() || input.source !== 'custom')) {
      throw new ModelManagementError('VALIDATION_FAILED', '自定义提供商名称不能为空')
    }
    if (input.apiKeyAction === 'replace' && !input.apiKey?.trim()) {
      throw new ModelManagementError('VALIDATION_FAILED', '请填写 API Key')
    }
  }

  private applyCredentialMutation(input: {
    providerId: string
    action: 'keep' | 'replace' | 'clear'
    value?: string
  }): void {
    if (input.action === 'replace') this.dependencies.credentials.write(input.providerId, input.value ?? '')
    if (input.action === 'clear') this.dependencies.credentials.remove(input.providerId)
  }

  private model(document: ModelManagementDocument, id: string): ManagedModel {
    const model = document.models.find((item) => item.id === id)
    if (!model) throw new ModelManagementError('VALIDATION_FAILED', `模型不存在：${id}`)
    return model
  }

  private connection(document: ModelManagementDocument, id: string): ManagedModelConnection {
    const connection = document.connections.find((item) => item.id === id)
    if (!connection) throw new ModelManagementError('VALIDATION_FAILED', `模型提供商不存在：${id}`)
    return connection
  }

  private providerRequestConfig(connection: ManagedModelConnection): ResolvedLlmRequestConfig {
    if (!connection.enabled) throw new Error(`模型提供商「${connection.name}」已停用`)
    const apiKey = this.dependencies.credentials.read(connection.providerId)
    if (!connection.local && !apiKey) {
      throw new Error(`请先为「${connection.name}」填写 API Key`)
    }
    const anthropic = connection.protocol === 'anthropic-messages'
    return {
      providerId: connection.providerId,
      providerName: connection.name,
      protocol: connection.protocol,
      apiKey,
      baseUrl: connection.baseUrl,
      local: connection.local,
      chatCompletionsUrl: anthropic ? undefined : endpoint(connection.baseUrl, 'chat/completions'),
      openAiModelsUrl: anthropic ? undefined : endpoint(connection.baseUrl, 'models'),
      messagesUrl: anthropic ? endpoint(connection.baseUrl, 'messages', true) : undefined,
      anthropicModelsUrl: anthropic ? endpoint(connection.baseUrl, 'models', true) : undefined
    }
  }

  private issueCredentialLease(connection: ManagedModelConnection): CredentialLease {
    let revoked = false
    const expiresAt = Date.now() + LEASE_TTL_MS
    return {
      leaseId: randomUUID(),
      credentialRef: connection.credentialRef,
      expiresAt,
      resolve: () => {
        if (revoked) throw new Error('模型凭据租约已撤销')
        if (Date.now() >= expiresAt) throw new Error('模型凭据租约已过期')
        const value = this.dependencies.credentials.read(connection.providerId)
        if (value) return value
        if (connection.local) return 'local-runtime'
        throw new Error(`模型连接 ${connection.providerId} 没有可用凭据`)
      },
      revoke: () => { revoked = true }
    }
  }
}

function userDataPath(): string {
  return readTestUserDataPath() ?? app.getPath('userData')
}

function writePrivateJson(target: string, value: unknown): void {
  const temporary = `${target}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, target)
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* preserve original error */ }
    throw error
  }
}

const productionStore: ModelConfigurationStore = {
  read() {
    try {
      return JSON.parse(fs.readFileSync(path.join(userDataPath(), CONFIG_FILE), 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(`读取模型配置失败：${(error as Error).message}`)
    }
  },
  write(document) {
    try {
      writePrivateJson(path.join(userDataPath(), CONFIG_FILE), document)
    } catch (error) {
      throw new Error(`保存模型配置失败：${(error as Error).message}`)
    }
  },
  backupLegacySettings(settings) {
    const root = userDataPath()
    const settingsBackup = path.join(root, SETTINGS_BACKUP_FILE)
    if (!fs.existsSync(settingsBackup)) {
      writePrivateJson(settingsBackup, buildLegacyLlmSettingsBackup(settings))
    }
  }
}

const productionCredentials: CredentialVaultPort = {
  has: hasLlmApiKey,
  read: getLlmApiKey,
  write(providerId, value) { saveLlmApiKeys({ [providerId]: value }) },
  remove: deleteLlmApiKey
}

const productionTransport: ProviderTransportPort = {
  async discover(config, signal) {
    const models = await listResolvedLlmProviderModels(config, signal)
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      kind: inferLlmModelKind(model)
    }))
  },
  test(config, signal) {
    return testResolvedLlmModelConnection({ ...config, signal })
  }
}

export const modelManagement = new ModelManagementModule({
  store: productionStore,
  credentials: productionCredentials,
  providerTransport: productionTransport,
  readLegacySettings: getSettings,
  now: () => new Date(),
  nextRevision: randomUUID
})
