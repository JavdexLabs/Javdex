import type {
  AgentProfile,
  AgentToolEffect,
  ModelCacheCompatibility,
  ModelCacheRetention,
  ModelRole
} from '@shared/aiConfigurationTypes'

export type AgentRunId = string
export type AgentOperationId = string
export type RuntimeCommandKind = 'prompt' | 'steer' | 'follow-up'

export interface OpaqueRuntimeSessionRef {
  runtimeId: 'pi'
  sessionId: string
  sessionFile: string
  codecVersion: 1
}

export interface RuntimeUserContent {
  text: string
}

export interface StableSystemPrompt {
  text: string
  sha256: string
}

export interface CredentialLease {
  readonly leaseId: string
  readonly credentialRef: string
  readonly expiresAt: number
  resolve(): string
  revoke(): void
}

export interface ResolvedPiModelDescriptor {
  providerId: string
  modelId: string
  name: string
  api: 'openai-completions' | 'anthropic-messages'
  baseUrl: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
}

export interface ResolvedModelPreset {
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high'
  /** Effective positive output limit frozen for this run; never the configuration sentinel 0. */
  maxTokens: number
  timeoutMs: number
  cacheRetention: ModelCacheRetention
}

export interface ResolvedModelAccess {
  credentialRef: string
  model: ResolvedPiModelDescriptor
  routeRevision: string
  preset: ResolvedModelPreset
  cacheCompatibility: ModelCacheCompatibility
  getCredentialLease(): Promise<CredentialLease>
  fetch?: typeof globalThis.fetch
}

export interface RuntimeCachePolicy {
  primaryAffinityId: string
  verifierAffinityId: string
  summarizerAffinityId: string
  retention: Record<ModelRole, ModelCacheRetention>
}

export interface PiRuntimeSettingsProjection {
  compaction: AgentProfile['compaction']
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number }
  /** Per product operation; 0/undefined means unlimited. */
  maxTurns?: number
}

export type PiNativeToolName = 'read' | 'write' | 'edit' | 'grep' | 'find' | 'ls' | 'bash'

/** Frozen, allowlisted Pi resources. Paths are resolved below sessionDirectory only. */
export interface PiRuntimeResources {
  nativeTools: PiNativeToolName[]
  skillNames: string[]
  /** SHA-256 by skill name; prevents a restored run from silently changing its Skill contract. */
  skillHashes?: Record<string, string>
}

export interface HostedToolResult {
  ok: boolean
  content: string
  summary: string
  detail?: string
  terminate?: boolean
  recovery?: Record<string, unknown>
}

export interface HostedToolBinding {
  name: string
  label: string
  description: string
  schema: Record<string, unknown>
  schemaHash: string
  capability: string
  effect: AgentToolEffect
  executionMode: 'sequential' | 'parallel'
  invoke(input: {
    runId: AgentRunId
    operationId?: AgentOperationId
    callId: string
    args: Record<string, unknown>
    signal: AbortSignal
    progress(summary: string): void
  }): Promise<HostedToolResult>
}

export interface RuntimeSessionInit {
  runId: AgentRunId
  resume?: OpaqueRuntimeSessionRef
  model: ResolvedModelAccess
  cache: RuntimeCachePolicy
  systemPrompt: StableSystemPrompt
  tools: readonly HostedToolBinding[]
  settings: PiRuntimeSettingsProjection
  resources?: PiRuntimeResources
  sessionDirectory: string
}

export type RuntimeSessionInitWithoutResume = Omit<RuntimeSessionInit, 'resume'>

export interface MessageAuditView {
  role: 'user' | 'assistant' | 'tool' | 'other'
  textPreview: string
  contentHash: string
  /** Provider-normalized reason for ending this message. */
  stopReason?: string
  /** Provider-native finish reason when it differs from stopReason. */
  rawStopReason?: string
  /** Safe audit metrics; a product use case may separately project a bounded display copy. */
  textChars?: number
  reasoningChars?: number
  toolCallCount?: number
  contentTypes?: string[]
}

export interface RuntimeRecoveryFrame {
  codecVersion: 1
  payload: string
  contentHash: string
}

export interface ToolCallAuditView {
  callId: string
  toolName: string
  argsDigest: string
}

export interface ToolResultAuditView {
  callId: string
  toolName: string
  ok: boolean
  summary: string
}

export interface NormalizedModelUsage {
  role: ModelRole
  routeRevision: string
  affinityHash: string
  cacheRetention: ModelCacheRetention
  input: number
  uncachedInput: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  totalInput: number
  totalTokens: number
  cost: number
  missedCost: number | null
  missedCostBasis?: 'prior-write' | 'stable-prefix-estimate'
  breakReason?: 'model-switch' | 'compaction' | 'ttl-expiry' | 'key-rotation' | 'runtime-rebuild' | 'unknown'
  breakReasonInferred?: boolean
}

export interface CompactionAuditView {
  reason: 'manual' | 'threshold' | 'overflow'
  tokensBefore?: number
  tokensAfter?: number
  firstKeptEntryId?: string
  summaryHash?: string
}

export type RuntimeFaultCategory =
  | 'checkpoint-corrupt'
  | 'checkpoint-incompatible'
  | 'checkpoint-migration-failed'
  | 'persistence-failed'
  | 'provider-failed'
  | 'runtime-failed'

export type RuntimeObservation =
  | { type: 'assistant.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'message.completed'; audit: MessageAuditView; recovery: RuntimeRecoveryFrame }
  | { type: 'tool.started'; call: ToolCallAuditView }
  | { type: 'tool.progress'; callId: string; summary: string }
  | { type: 'tool.completed'; result: ToolResultAuditView; recovery: RuntimeRecoveryFrame }
  | { type: 'queue.changed'; steering: number; followUp: number }
  | { type: 'retry.changed'; phase: 'start' | 'end'; attempt: number }
  | { type: 'compaction.changed'; phase: 'start' | 'end'; result?: CompactionAuditView }
  | { type: 'usage'; usage: NormalizedModelUsage }
  | { type: 'limit.reached'; resource: 'model-turns'; current: number; limit: number }
  | { type: 'session.saved'; ref: OpaqueRuntimeSessionRef }
  | { type: 'agent.settled'; acceptedCommandIds: readonly AgentOperationId[] }
  | { type: 'runtime.fault'; category: RuntimeFaultCategory; message: string }

export type RuntimeDurableObservation = Exclude<
  RuntimeObservation,
  { type: 'assistant.delta' | 'reasoning.delta' | 'tool.progress' }
>

export interface RuntimeObserver {
  notify(event: RuntimeObservation): void
  commit(event: RuntimeDurableObservation): Promise<void>
}

export interface RuntimeSessionPort {
  readonly ref: OpaqueRuntimeSessionRef
  dispatch(command: {
    commandId: AgentOperationId
    kind: RuntimeCommandKind
    content: RuntimeUserContent
  }): Promise<{ accepted: boolean }>
  requestManualCompaction(
    commandId: AgentOperationId,
    instructions?: string
  ): Promise<{ accepted: boolean }>
  abort(reason?: string): Promise<void>
  dispose(): Promise<void>
}

export interface AgentRuntimePort {
  readonly runtimeId: 'pi'
  open(
    input: RuntimeSessionInit,
    observer: RuntimeObserver
  ): Promise<{ source: 'created' | 'restored'; session: RuntimeSessionPort }>
  rebuild(
    input: RuntimeSessionInitWithoutResume,
    history: readonly ExecutionHistoryFrame[],
    observer: RuntimeObserver
  ): Promise<RuntimeSessionPort>
}

export interface ExecutionHistoryFrame {
  seq: number
  runtimeId: 'pi'
  codecVersion: 1
  audit: Record<string, unknown>
  recovery: RuntimeRecoveryFrame
  contentHash: string
}

export interface ResolvedRunConfiguration {
  revision: string
  definitionId: string
  profile: AgentProfile
  model: ResolvedModelAccess
  /** Frozen separately because verifier requests do not flow through the Pi primary runtime. */
  verifierModel?: ResolvedModelAccess
  cache: RuntimeCachePolicy
  systemPrompt: StableSystemPrompt
  tools: readonly HostedToolBinding[]
  settings: PiRuntimeSettingsProjection
  resources?: PiRuntimeResources
  sessionDirectory: string
}

export interface FrozenModelAccessSnapshot {
  credentialRef: string
  descriptor: ResolvedPiModelDescriptor
  routeRevision: string
  preset: ResolvedModelPreset
  cacheCompatibility: ModelCacheCompatibility
}

export interface PersistedRunConfigurationSnapshot {
  revision: string
  definitionId: string
  profile: AgentProfile
  model: FrozenModelAccessSnapshot
  /** Missing only on legacy snapshots created before verifier routes were frozen. */
  verifierModel?: FrozenModelAccessSnapshot
  cache: RuntimeCachePolicy
  systemPrompt: StableSystemPrompt
  tools: Array<Omit<HostedToolBinding, 'invoke'>>
  settings: PiRuntimeSettingsProjection
  resources?: PiRuntimeResources
}
