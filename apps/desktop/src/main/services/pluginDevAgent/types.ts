import type {
  PluginDevAgentEvent,
  PluginDevAgentPhase,
  PluginDevAgentStartInput,
  PluginDevAgentWorkLogEntry,
  PluginDevPendingUserRequest,
  PluginDevRunTarget,
  PluginExecutionArtifact,
  PluginRunAcceptanceOutcome,
  PluginDevSessionStatus
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
  maxHtmlChars: number
}

export interface PluginDevSession extends PluginDevAgentStartInput {
  id: string
  status: PluginDevSessionStatus
  package: ScraperPluginPackage
  runTargets: PluginDevRunTarget[]
  workspaceDirectory?: string
  /** Recoverable validation error for the on-disk draft; package remains the last valid snapshot. */
  workspaceDraftError?: string
  lastExecution?: PluginExecutionArtifact
  acceptance?: PluginRunAcceptanceOutcome
  pendingUserRequest?: PluginDevPendingUserRequest
  step: number
  limits: PluginDevSessionLimits
  cancelRequested: boolean
  phase: PluginDevAgentPhase
  totalTokens: number
  usageByRole?: NonNullable<import('@shared/pluginDevTypes').PluginDevAgentContextStats['usageByRole']>
  contextInputTokens?: number
  modelTurnCount: number
  discoveryToolCalls: number
  /** When true, agent should prefer replace_function over replace_all. */
  incrementalEditOnly: boolean
  /** Terminal sessions are eligible for in-memory cleanup after this timestamp is set. */
  endedAt?: number
  /** Authoritative reason for the latest failed transition, persisted for audit fallback. */
  failureMessage?: string
  /** Latest user instruction (start message or continue text). */
  lastUserInstruction?: string
  /** Full agent work log for export / workflow analysis (tool details untruncated). */
  workLog?: PluginDevAgentWorkLogEntry[]
}

export interface ToolExecutionResult {
  ok: boolean
  content: string
  structured?: Record<string, unknown>
  events?: PluginDevAgentEvent[]
  waitForUser?: string
  pendingUserRequest?: PluginDevPendingUserRequest
  finish?: { success: boolean; summary: string }
}

export type PluginDevAgentProgressCallback = (event: PluginDevAgentEvent) => void
