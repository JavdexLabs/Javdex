import type { ActressScrapeField, ActressScrapeResult } from './actressScrapeTypes'
import type { ScraperPluginDescriptor, ScraperPluginKind, ScraperPluginPackage } from './scraperPluginTypes'
import type { ScrapeResult, VideoScrapeField } from './videoScrapeTypes'

export interface PluginDevAgentInput {
  kind: ScraperPluginKind
  siteName: string
  siteUrl?: string
  description?: string
  supportedFields: Array<VideoScrapeField | ActressScrapeField>
  /** Unified test targets (video codes or actress names). */
  testTargets?: string[]
}

export type PluginDevAgentMode = 'create' | 'debug' | 'feedback'

export type PluginDevSessionStatus =
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type PluginDevAgentPhase =
  | 'idle'
  | 'discover'
  | 'implement'
  | 'dry_run'
  | 'verify'
  | 'finish'
  | 'waiting_user'

export interface PluginDevAgentContextStats {
  messageCount: number
  originalChars: number
  compressedChars: number
  savedChars: number
  estimatedTokens: number
  totalTokens: number
  maxTokens: number
  overBudget: boolean
}

export interface PluginDevAgentStartInput extends PluginDevAgentInput {
  mode: PluginDevAgentMode
  userMessage?: string
  package?: ScraperPluginPackage
  /** Prior manual or UI dry-run to seed the session context. */
  lastDryRun?: PluginDevDryRunResult
  /** Test override; production uses settings.pluginDevAgentMaxSteps. */
  maxSteps?: number
  /** Test override; production uses settings.pluginDevAgentMaxContextTokens. */
  maxContextTokens?: number
}

export interface PluginDevAgentMessageInput {
  sessionId: string
  text: string
  /** Latest dry-run from UI to refresh session context when continuing. */
  lastDryRun?: PluginDevDryRunResult
}

export type PluginDevAgentEvent =
  | { type: 'step_start'; sessionId: string; step: number }
  | { type: 'phase_updated'; sessionId: string; step: number; phase: PluginDevAgentPhase }
  | {
      type: 'context_updated'
      sessionId: string
      step: number
      stats: PluginDevAgentContextStats
    }
  | { type: 'assistant_text'; sessionId: string; step: number; text: string }
  | {
      type: 'tool_start'
      sessionId: string
      step: number
      tool: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      sessionId: string
      step: number
      tool: string
      ok: boolean
      summary: string
      detail?: string
    }
  | {
      type: 'package_updated'
      sessionId: string
      step: number
      package: ScraperPluginPackage
    }
  | {
      type: 'plugin_installed'
      sessionId: string
      step: number
      package: ScraperPluginPackage
      descriptor: ScraperPluginDescriptor
    }
  | {
      type: 'dry_run_updated'
      sessionId: string
      step: number
      dryRun: PluginDevDryRunResult
    }
  | {
      type: 'verification_updated'
      sessionId: string
      step: number
      verification: PluginDevVerificationReport
    }
  | { type: 'waiting_user'; sessionId: string; step: number; reason: string }
  | {
      type: 'done'
      sessionId: string
      step: number
      success: boolean
      summary: string
      package: ScraperPluginPackage
      dryRun?: PluginDevDryRunResult
      verification?: PluginDevVerificationReport
    }
  | { type: 'error'; sessionId: string; step: number; message: string }

/** One row in the exportable plugin-dev agent work log (full fidelity for workflow analysis). */
export type PluginDevAgentWorkLogEntry =
  | {
      at: string
      kind: 'event'
      event: PluginDevAgentEvent
    }
  | {
      at: string
      kind: 'user_message'
      sessionId: string
      source: 'start' | 'continue'
      text: string
    }

export interface PluginDevAgentWorkLogExport {
  schemaVersion: 1
  kind: 'pluginDevAgentWorkLog'
  exportedAt: string
  sessionId: string
  meta: {
    mode: PluginDevAgentMode
    pluginKind: ScraperPluginKind
    siteName: string
    siteUrl?: string
    status: PluginDevSessionStatus
    phase: PluginDevAgentPhase
    step: number
    totalTokens: number
    maxSteps: number
    maxContextTokens: number
    testTargets: string[]
    supportedFields: string[]
    endedAt?: string
  }
  /** Compact human-readable timeline derived from entries. */
  timeline: string[]
  entries: PluginDevAgentWorkLogEntry[]
  package: ScraperPluginPackage
  lastDryRun?: PluginDevDryRunResult
  lastVerification?: PluginDevVerificationReport
}

export interface PluginDevAgentSessionResult {
  sessionId: string
  status: PluginDevSessionStatus
  package: ScraperPluginPackage
  dryRun?: PluginDevDryRunResult
  verification?: PluginDevVerificationReport
  summary: string
}

export interface PluginDevPageInsight {
  label: string
  url: string
  title: string
  text: string
  forms: Array<{
    selector: string
    action?: string
    method?: string
    inputs: Array<{
      selector: string
      name?: string
      type?: string
      placeholder?: string
      value?: string
    }>
    buttons: Array<{
      selector: string
      text: string
      type?: string
    }>
  }>
  links: Array<{
    text: string
    href: string
    region?: 'breadcrumb' | 'metadata' | 'other'
    parentSelector?: string
  }>
  domRegions?: Array<{
    label: string
    selector: string
    html: string
  }>
  definitionLists?: Array<{
    selector: string
    items: Array<{
      term: string
      value: string
      valueHtml?: string
    }>
  }>
}

export interface PluginDevDiscovery {
  pages: PluginDevPageInsight[]
  notes: string[]
}

export type PluginDevVerificationStatus =
  | 'ok'
  | 'missing_in_result'
  | 'not_on_page'
  | 'suspicious'
  | 'invalid_key'

export interface PluginDevFieldVerification {
  field: string
  status: PluginDevVerificationStatus
  actual?: string
  pageHint?: string
  note: string
}

export interface PluginDevVerificationReport {
  referencePage?: PluginDevPageInsight
  items: PluginDevFieldVerification[]
  summary: string
}

export interface PluginDevVerifyInput {
  kind: ScraperPluginKind
  lastResult?: unknown
  discovery?: PluginDevDiscovery
  supportedFields: Array<VideoScrapeField | ActressScrapeField>
  userFeedback?: string
  /** Agent mode; affects verify prompt and post-verify supportedFields sync behavior. */
  mode?: PluginDevAgentMode
  /** Target under verification (single case). */
  testTarget?: string
  testTargets?: string[]
}

export interface PluginDevDryRunInput {
  package: ScraperPluginPackage
  /** Primary target for this dry-run invocation. */
  testTarget?: string
  testTargets?: string[]
}

export interface PluginDevDryRunCase {
  target: string
  ok: boolean
  result: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  logs: string[]
  error?: string
}

export interface PluginDevDryRunResult {
  ok: boolean
  result: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  logs: string[]
  error?: string
  /** Present when one Agent dry-run covered multiple test targets. */
  cases?: PluginDevDryRunCase[]
}

export interface PluginDevInstallInput {
  package: ScraperPluginPackage
  overwriteUser?: boolean
}
