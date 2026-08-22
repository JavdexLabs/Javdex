import type { LlmProviderProtocol } from './llmProviders'

export type ModelRole = 'primary' | 'verifier' | 'summarizer'
export type ModelCacheRetention = 'none' | 'short' | 'long'
export type ModelCapabilityState = boolean | 'unknown'

export interface ModelProbeEvidence {
  source: 'probe' | 'manual' | 'migration'
  checkedAt: string
  note?: string
}

export interface ModelCacheCompatibility {
  supportsPromptCache: ModelCapabilityState
  supportsLongCacheRetention: boolean
  cacheControlFormat?: 'anthropic'
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'
  sendSessionAffinityHeaders: boolean
  evidence: ModelProbeEvidence
}

export interface ModelConnection {
  id: string
  name: string
  providerId: string
  protocol: LlmProviderProtocol
  baseUrl: string
  proxyUrl?: string
  credentialRef: string
  enabled: boolean
}

export interface ModelRecord {
  id: string
  connectionId: string
  modelId: string
  name: string
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

export interface ModelPreset {
  id: string
  name: string
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high'
  /** 0 removes the preset cap and uses the selected model's declared maximum. */
  maxTokens: number
  timeoutMs: number
  cacheRetention: ModelCacheRetention
}

export interface AIRoute {
  id: string
  name: string
  role: ModelRole
  modelRecordId: string
  presetId: string
}

export interface AgentProfile {
  id: string
  name: string
  definitionId: string
  routes: Record<ModelRole, string>
  toolPackRefs: string[]
  capabilityGrants: string[]
  approvalRequiredEffects: AgentToolEffect[]
  compaction: {
    enabled: boolean
    reserveTokens: number
    keepRecentTokens: number
  }
}

export type AgentToolEffect = 'read' | 'write' | 'network' | 'install' | 'credential-sensitive'

export interface AIConfigurationDocument {
  schemaVersion: 2
  revision: string
  updatedAt: string
  modelConnections: ModelConnection[]
  modelRecords: ModelRecord[]
  modelPresets: ModelPreset[]
  routes: AIRoute[]
  agentProfiles: AgentProfile[]
}

export interface AIConfigurationSnapshot extends AIConfigurationDocument {
  validationErrors: string[]
}

export interface AIConfigurationUpdateInput {
  expectedRevision: string
  document: Omit<AIConfigurationDocument, 'revision' | 'updatedAt'>
}

export interface ResolvedAgentProfileView {
  profileId: string
  profileName: string
  revision: string
  primary: { providerName: string; modelName: string; routeName: string }
  verifier: { providerName: string; modelName: string; routeName: string }
  summarizer: { providerName: string; modelName: string; routeName: string }
}
