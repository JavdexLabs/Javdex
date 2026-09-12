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
