import type { ActressScrapeField, ActressScrapeResult } from './actressScrapeTypes'
import type { PluginManifestCoverage } from './pluginResultContract'
import type { ScraperPluginKind, ScraperPluginPackage } from './scraperPluginTypes'
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

/** Exact runtime input used by the plugin sandbox. Browser URLs are never run targets. */
export type PluginDevRunTarget =
  | {
      kind: 'video'
      code: string
    }
  | {
      kind: 'actress'
      mainName: string
      aliases: string[]
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
  | 'working'
  | 'checking'
  | 'ready'
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
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  usageByRole?: Partial<Record<'primary' | 'verifier' | 'summarizer', {
    uncachedInput: number
    cacheRead: number
    cacheWrite: number
    output: number
    reasoning: number
    totalTokens: number
  }>>
}

export interface PluginDevAgentStartInput extends PluginDevAgentInput {
  mode: PluginDevAgentMode
  userMessage?: string
  package?: ScraperPluginPackage
  /** Test override; production uses the plugin-developer workload assignment. */
  maxSteps?: number
  /** Test override; production uses the plugin-developer workload assignment. */
  maxContextTokens?: number
}

export interface PluginDevAgentMessageInput {
  sessionId: string
  text: string
  /** Distinguishes a button-driven resume from new defect or requirement feedback. */
  continuationKind?: 'resume' | 'user_feedback'
  /** Exact one-use decision. Plain chat text never grants a tool permit. */
  approvalDecision?: {
    requestId: string
    decision: 'approve' | 'deny'
  }
  /** Exact response to a pending product-domain question. */
  userResponse?: PluginDevUserResponse
}

export interface PluginDevPendingApproval {
  requestId: string
  tool: string
  args: Record<string, unknown>
  reason: string
}

export type PluginDevBrowserInteractionReason =
  | 'human_verification'
  | 'login'
  | 'required_user_action'

export interface PluginDevChoiceDecision {
  requestId: string
  question: string
  selectedOption: {
    id: string
    label: string
    description?: string
  }
  evidenceRefs: string[]
}

export type PluginDevPendingUserRequest =
  | {
      requestId: string
      type: 'browser_interaction'
      reason: PluginDevBrowserInteractionReason
      prompt: string
      url?: string
    }
  /** Legacy read compatibility for PluginDeveloper runs created before ToolPack v11. */
  | {
      requestId: string
      type: 'browser_challenge'
      prompt: string
      url?: string
    }
  | {
      requestId: string
      type: 'freeform'
      prompt: string
    }
  | {
      requestId: string
      type: 'choice'
      prompt: string
      options: Array<{ id: string; label: string; description?: string }>
      evidenceRefs: string[]
    }

export type PluginDevUserResponse =
  | { requestId: string; type: 'browser_interaction'; action: 'completed' }
  | { requestId: string; type: 'browser_challenge'; action: 'completed' }
  | { requestId: string; type: 'freeform'; text: string }
  | { requestId: string; type: 'choice'; optionId: string }

export type PluginDevAgentEvent =
  | { type: 'step_start'; sessionId: string; step: number }
  | { type: 'phase_updated'; sessionId: string; step: number; phase: PluginDevAgentPhase }
  | {
      type: 'context_updated'
      sessionId: string
      step: number
      stats: PluginDevAgentContextStats
    }
  | {
      type: 'assistant_text_delta'
      sessionId: string
      step: number
      turn: number
      delta: string
    }
  | {
      type: 'assistant_reasoning_delta'
      sessionId: string
      step: number
      turn: number
      delta: string
    }
  | { type: 'assistant_text'; sessionId: string; step: number; turn?: number; text: string }
  | {
      type: 'assistant_reasoning'
      sessionId: string
      step: number
      turn: number
      text: string
      charCount: number
      truncated: boolean
    }
  | {
      type: 'model_turn_completed'
      sessionId: string
      step: number
      stopReason?: string
      rawStopReason?: string
      textChars: number
      reasoningChars: number
      toolCallCount: number
    }
  | {
      type: 'workspace_status'
      sessionId: string
      step: number
      valid: boolean
      message: string
    }
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
      type: 'run_targets_updated'
      sessionId: string
      step: number
      runTargets: PluginDevRunTarget[]
    }
  | {
      type: 'execution_updated'
      sessionId: string
      step: number
      execution: PluginExecutionArtifact
    }
  | {
      type: 'acceptance_updated'
      sessionId: string
      step: number
      outcome: PluginRunAcceptanceOutcome
    }
  | ({ type: 'approval_required'; sessionId: string; step: number } & PluginDevPendingApproval)
  | {
      type: 'user_input_required'
      sessionId: string
      step: number
      request: PluginDevPendingUserRequest
    }
  | { type: 'waiting_user'; sessionId: string; step: number; reason: string }
  | {
      type: 'done'
      sessionId: string
      step: number
      success: boolean
      summary: string
      package: ScraperPluginPackage
      execution?: PluginExecutionArtifact
      acceptance?: PluginRunAcceptanceOutcome
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
  schemaVersion: 7
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
    modelTurnCount: number
    discoveryToolCalls: number
    maxSteps: number
    maxContextTokens: number
    runTargets: PluginDevRunTarget[]
    supportedFields: string[]
    endedAt?: string
  }
  /** Compact human-readable timeline derived from entries. */
  timeline: string[]
  entries: PluginDevAgentWorkLogEntry[]
  package: ScraperPluginPackage
  lastExecution?: PluginExecutionArtifact
  acceptance?: PluginRunAcceptanceOutcome
}

export interface PluginDevAgentSessionResult {
  sessionId: string
  status: PluginDevSessionStatus
  /** Model configuration frozen when this run started; settings changes affect only later runs. */
  frozenModel?: PluginDevFrozenModelSummary
  package: ScraperPluginPackage
  runTargets: PluginDevRunTarget[]
  execution?: PluginExecutionArtifact
  acceptance?: PluginRunAcceptanceOutcome
  /** Schema-v5/v6 history may be inspected but cannot resume or satisfy runtime-v2 installation. */
  historicalReadOnly?: boolean
  summary: string
}

export interface PluginDevFrozenModelSummary {
  providerId: string
  modelId: string
  modelName: string
  revision: string
}

export interface PluginDevAgentSnapshot {
  cursor: number
  input: PluginDevAgentStartInput
  result: PluginDevAgentSessionResult
  phase: PluginDevAgentPhase
  step: number
  totalTokens: number
  events: PluginDevAgentEvent[]
  workLog: PluginDevAgentWorkLogEntry[]
  pendingApprovals?: PluginDevPendingApproval[]
  pendingUserRequest?: PluginDevPendingUserRequest
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
    rawHref?: string
    region?: 'breadcrumb' | 'metadata' | 'other'
    parentSelector?: string
  }>
  /** Inspect-classified language anchors only. Empty means none found, not that the page has no language UI. */
  localeLinks?: Array<{
    text: string
    href: string
    rawHref?: string
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
  metadataTags?: Array<{
    key: string
    content: string
  }>
  structuredData?: Array<{
    selector: string
    key: string
    value: string
  }>
  labeledRows?: Array<{
    selector: string
    label: string
    value: string
    links: string[]
  }>
}

export interface PluginDevDiscovery {
  pages: PluginDevPageInsight[]
  notes: string[]
}

export interface PluginExecutionCase {
  target: PluginDevRunTarget
  pluginResult: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  effectiveResult: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  manifestCoverage: PluginManifestCoverage
  /** Raw plugin result keys that are not part of the current kind contract. */
  unrecognizedResultKeys?: string[]
  /** Read-only compatibility label produced when rendering schema-v5 history. */
  legacyProjectionKeys?: string[]
  logs: string[]
  error?: string
  runtimeAccepted: boolean
}

export interface PluginExecutionArtifact {
  runtimeVersion: string
  artifactHash: string
  targetFingerprint: string
  scope: 'targeted' | 'all'
  targets: PluginDevRunTarget[]
  cases: PluginExecutionCase[]
  executionPassed: boolean
  reportPath: string
  cached?: boolean
}

export interface PluginRunAcceptanceOutcome {
  runtimeVersion: string
  artifactHash: string
  targetFingerprint: string
  scope: 'targeted' | 'all'
  executionPassed: boolean
  ready: boolean
  reportPath: string
}

export interface PluginDevDryRunInput {
  package: ScraperPluginPackage
  /** Preferred typed runtime input for PluginDeveloper v13. */
  runTarget?: PluginDevRunTarget
  /** Primary target for this dry-run invocation. */
  testTarget?: string
  testTargets?: string[]
}

export interface PluginDevDryRunCase {
  target: string
  ok: boolean
  result: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  pluginResult?: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  effectiveResult?: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  manifestCoverage?: PluginManifestCoverage
  /** Collected from the raw plugin result before normalization. */
  unrecognizedResultKeys?: string[]
  logs: string[]
  error?: string
}

export interface PluginDevDryRunResult {
  ok: boolean
  result: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  /** Normalized value returned by the plugin before supportedFields projection. */
  pluginResult?: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  /** Value that the production runtime actually exposes after projection. */
  effectiveResult?: ScrapeResult | ScrapeResult[] | ActressScrapeResult | null
  /** Mechanical field-level relationship between plugin output and the manifest. */
  manifestCoverage?: PluginManifestCoverage
  /** Raw result keys not recognized by the current kind contract; contains no suggestions. */
  unrecognizedResultKeys?: string[]
  logs: string[]
  error?: string
  /** Present when one Agent dry-run covered multiple test targets. */
  cases?: PluginDevDryRunCase[]
  /** Exact configured targets covered by this execution, including a single-target run. */
  targets?: string[]
  /** SHA-256 of the code/package that produced this result. */
  codeFingerprint?: string
  packageFingerprint?: string
}

export interface PluginDevInstallInput {
  package: ScraperPluginPackage
  overwriteUser?: boolean
  /** When installation follows an Agent run, binds it to that run's current ready artifact. */
  sessionId?: string
}
