import type {
  PluginDevAgentEvent,
  PluginDevAgentPhase,
  PluginDevAgentStartInput,
  PluginDevAgentWorkLogEntry,
  PluginDevDryRunResult,
  PluginDevPageInsight,
  PluginDevSessionStatus,
  PluginDevVerificationReport
} from '@shared/pluginDevTypes'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'

export type {
  PluginDevAgentEvent,
  PluginDevAgentPhase,
  PluginDevAgentMessageInput,
  PluginDevAgentMode,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevSessionStatus
} from '@shared/pluginDevTypes'

export interface PluginDevSessionLimits {
  maxSteps: number
  maxContextTokens: number
  maxDuplicateDryRun: number
  maxHtmlChars: number
}

export interface PluginDevSession extends PluginDevAgentStartInput {
  id: string
  status: PluginDevSessionStatus
  package: ScraperPluginPackage
  pageNotes: Array<{ text: string; at: number }>
  lastDryRun?: PluginDevDryRunResult
  lastVerification?: PluginDevVerificationReport
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
  lastInspectPage?: PluginDevPageInsight
  /** Last injected verification failure hash; avoids repeating identical feedback every loop. */
  lastVerificationPromptHash?: string
  /** Latest user instruction (start message or continue text). */
  lastUserInstruction?: string
  /** Protocol-neutral conversation persisted across continue/resume. */
  transcript?: import('./agentMessages').AgentTranscript
  /** Full agent work log for export / workflow analysis (tool details untruncated). */
  workLog?: PluginDevAgentWorkLogEntry[]
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
