import type {
  ModelCacheCompatibility,
  ModelCacheRetention,
  ModelCapabilityState
} from './aiConfigurationTypes'
import type { LlmApiKeyAction, LlmProviderProtocol } from './llmProviders'

export type ModelWorkloadId = 'app-default' | 'plugin-developer' | 'library-curator'
export type ModelCandidateKind = 'chat' | 'embedding'

export interface ManagedModelConnection {
  id: string
  providerId: string
  name: string
  source: 'builtin' | 'custom'
  protocol: LlmProviderProtocol
  baseUrl: string
  proxyUrl?: string
  credentialRef: string
  local: boolean
  agentCompatible: boolean
  enabled: boolean
}

export interface ModelRuntimeMetadata {
  api: 'openai-completions' | 'anthropic-messages'
  contextWindow: number
  maxTokens: number
  capabilities: {
    tools: ModelCapabilityState
    vision: ModelCapabilityState
    reasoning: ModelCapabilityState
  }
  cache: ModelCacheCompatibility
}

export interface ManualModelOverrides {
  contextWindow?: number
  maxTokens?: number
  capabilities?: Partial<ModelRuntimeMetadata['capabilities']>
  cache?: Partial<Omit<ModelCacheCompatibility, 'evidence'>> & {
    evidence: ModelCacheCompatibility['evidence']
  }
}

export interface ManagedModel {
  id: string
  connectionId: string
  modelId: string
  name: string
  kind: ModelCandidateKind
  builtin: boolean
  baseline: ModelRuntimeMetadata
  manualOverrides?: ManualModelOverrides
}

export interface WorkloadRuntimeSettings {
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high'
  /** 0 means use the selected model's declared maximum. */
  maxTokens: number
  timeoutMs: number
  cacheRetention: ModelCacheRetention
}

export interface WorkloadCompactionSettings {
  enabled: boolean
  reserveTokens: number
  keepRecentTokens: number
}

export interface WorkloadLimits {
  /** Per operation; 0 means unlimited. */
  maxTurns: number
  maxContextTokens: number
}

export type WorkloadModelSelection =
  | { mode: 'inherit-default' }
  | { mode: 'explicit'; modelRef: string }

export interface ModelWorkloadAssignment {
  workloadId: ModelWorkloadId
  model: WorkloadModelSelection
  runtime: WorkloadRuntimeSettings
  compaction: WorkloadCompactionSettings
  limits: WorkloadLimits
}

export interface ModelManagementDocument {
  schemaVersion: 3
  revision: string
  updatedAt: string
  connections: ManagedModelConnection[]
  models: ManagedModel[]
  assignments: ModelWorkloadAssignment[]
}

export type ManagedConnectionStatus = 'ready' | 'unconfigured' | 'disabled'

export interface ManagedModelConnectionView extends Omit<ManagedModelConnection, 'credentialRef' | 'proxyUrl'> {
  hasCredential: boolean
  status: ManagedConnectionStatus
  modelCount: number
}

export interface ManagedModelView extends Omit<ManagedModel, 'manualOverrides'> {
  manualOverrides?: ManualModelOverrides
  effective: ModelRuntimeMetadata
  hasManualOverrides: boolean
}

export interface ModelWorkloadResolution {
  ready: boolean
  modelRef?: string
  providerName?: string
  modelName?: string
  reason?: string
}

export interface ModelWorkloadAssignmentView extends ModelWorkloadAssignment {
  resolution: ModelWorkloadResolution
}

export interface ModelManagementSnapshot {
  schemaVersion: 3
  revision: string
  updatedAt: string
  connections: ManagedModelConnectionView[]
  models: ManagedModelView[]
  assignments: ModelWorkloadAssignmentView[]
  validationErrors: string[]
}

export interface SaveModelConnectionInput {
  providerId: string
  name: string
  source: 'builtin' | 'custom'
  protocol: LlmProviderProtocol
  baseUrl: string
  local?: boolean
  agentCompatible?: boolean
  enabled?: boolean
  apiKeyAction: LlmApiKeyAction
  apiKey?: string
}

export type ModelManagementCommand =
  | { type: 'set-default-model'; modelRef: string }
  | {
      type: 'set-workload-assignment'
      workloadId: Exclude<ModelWorkloadId, 'app-default'>
      model: WorkloadModelSelection
      runtime: WorkloadRuntimeSettings
      compaction: WorkloadCompactionSettings
      limits: WorkloadLimits
    }
  | { type: 'save-connection'; connection: SaveModelConnectionInput }
  | { type: 'remove-connection'; connectionId: string }
  | { type: 'add-model'; connectionId: string; modelId: string; name: string }
  | { type: 'remove-model'; modelRef: string }
  | { type: 'set-model-override'; modelRef: string; patch: ManualModelOverrides }
  | { type: 'reset-model-override'; modelRef: string }

export interface ModelManagementApplyInput {
  expectedRevision: string
  command: ModelManagementCommand
}

export type ModelManagementErrorCode =
  | 'REVISION_CONFLICT'
  | 'MODEL_IN_USE'
  | 'CONNECTION_IN_USE'
  | 'CONNECTION_NOT_READY'
  | 'MODEL_NOT_TOOL_CAPABLE'
  | 'LONG_CACHE_UNSUPPORTED'
  | 'VALIDATION_FAILED'
  | 'MODEL_CONFIG_PARTIAL_WRITE'

export interface ModelManagementMutationError {
  code: ModelManagementErrorCode
  message: string
  usages?: ModelWorkloadId[]
}

export type ModelManagementApplyResult =
  | { ok: true; snapshot: ModelManagementSnapshot }
  | { ok: false; error: ModelManagementMutationError }

export interface ModelCandidate {
  id: string
  name: string
  kind: ModelCandidateKind
}

export interface ModelTestResult {
  modelRef: string
  sample: string
}
