import type {
  PluginDevAgentEvent,
  PluginDevAgentPhase,
  PluginDevAgentMessageInput,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevSessionStatus
} from '@shared/types'

export type {
  PluginDevAgentEvent,
  PluginDevAgentPhase,
  PluginDevAgentMessageInput,
  PluginDevAgentMode,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevSessionStatus
} from '@shared/types'

export interface PluginDevSessionLimits {
  maxSteps: number
  maxContextTokens: number
  maxDuplicateDryRun: number
  maxHtmlChars: number
}

export interface PluginDevSession extends PluginDevAgentStartInput {
  id: string
  status: PluginDevSessionStatus
  package: import('@shared/types').ScraperPluginPackage
  pageNotes: Array<{ text: string; at: number }>
  lastDryRun?: import('@shared/types').PluginDevDryRunResult
  lastVerification?: import('@shared/types').PluginDevVerificationReport
  /** package.code hash when lastDryRun was produced; used to detect stale verify. */
  lastDryRunCodeHash?: string
  lastCodeHash?: string
  duplicateDryRunCount: number
  step: number
  limits: PluginDevSessionLimits
  finishRequested: boolean
  cancelRequested: boolean
  phase: PluginDevAgentPhase
  totalTokens: number
  /** When true, agent should prefer replace_function over replace_all. */
  incrementalEditOnly: boolean
  /** Terminal sessions are eligible for in-memory cleanup after this timestamp is set. */
  endedAt?: number
  lastInspectPage?: import('@shared/types').PluginDevPageInsight
  /** Last injected verification failure hash; avoids repeating identical feedback every loop. */
  lastVerificationPromptHash?: string
  /** Latest user instruction (start message or continue text). */
  lastUserInstruction?: string
  /** Protocol-neutral conversation persisted across continue/resume. */
  transcript?: import('./agentMessages').AgentTranscript
}

export interface ToolExecutionResult {
  ok: boolean
  content: string
  structured?: Record<string, unknown>
  events?: PluginDevAgentEvent[]
  waitForUser?: string
  finish?: { success: boolean; summary: string }
}

export type PluginDevAgentProgressCallback = (event: PluginDevAgentEvent) => void
