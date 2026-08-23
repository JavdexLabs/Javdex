export interface ScrapeBrowserFetchPageOptions {
  readySelector?: string
  /** Normal page loading budget; time spent on Cloudflare verification is excluded. */
  timeoutMs?: number
  /** Body/title matches this → page is treated as loaded. */
  settleWhenText?: RegExp
  /** Return as soon as a challenge is visible so an interactive caller can hand off. */
  returnOnChallenge?: boolean
}

export interface ScrapeBrowserFetchBufferOptions {
  referer?: 'omit' | 'session' | string
  headers?: Readonly<Record<string, string>>
}

export interface ScrapeBrowserResourceResponse {
  statusCode: number
  body: Buffer
  etag?: string
}

export class ScrapeBrowserChallengeError extends Error {
  readonly code = 'CHALLENGE' as const
  readonly url: string
  readonly title: string

  constructor(input: { url?: string; title?: string }) {
    super('当前页面为 Cloudflare 挑战')
    this.name = 'ScrapeBrowserChallengeError'
    this.url = input.url ?? ''
    this.title = input.title ?? ''
  }
}

export function isScrapeBrowserChallengeError(
  error: unknown
): error is ScrapeBrowserChallengeError {
  const candidate = error as Partial<ScrapeBrowserChallengeError> | null
  return (
    error instanceof ScrapeBrowserChallengeError ||
    (Boolean(candidate) &&
      typeof error === 'object' &&
      candidate?.name === 'ScrapeBrowserChallengeError' &&
      candidate.code === 'CHALLENGE' &&
      typeof candidate.url === 'string' &&
      typeof candidate.title === 'string')
  )
}

export type AgentBrowserCommand =
  | { action: 'open'; url: string; readySelector?: string; timeoutMs?: number }
  | { action: 'snapshot'; target?: string; depth?: number; boxes?: boolean }
  | { action: 'find'; text?: string; regex?: string }
  | { action: 'html'; target?: string; maxLength?: number }
  | { action: 'evaluate'; expression: string; timeoutMs?: number }
  | { action: 'click'; target: string }
  | { action: 'fill'; target: string; text: string; submit?: boolean }
  | { action: 'press'; key: string; target?: string }
  | { action: 'wait'; target?: string; timeoutMs?: number }
  | { action: 'status' }

export type AgentBrowserObservationMode = 'full' | 'artifact' | 'delta' | 'unchanged' | 'pending'

export interface AgentBrowserPageFactSectionSummary {
  section: string
  byteLength: number
  itemCount: number
}

export interface AgentBrowserObservation {
  action: AgentBrowserCommand['action']
  documentRevision?: string
  observationMode?: AgentBrowserObservationMode
  /** A state-changing action completed even if its post-action observation is still pending. */
  actionSucceeded?: boolean
  url?: string
  title?: string
  snapshot?: string
  snapshotArtifact?: string
  ariaDelta?: string
  matches?: Array<{ ref?: string; text: string }>
  html?: string
  value?: unknown
  /** Host-collected page facts: visible labels, structured metadata, forms and content links. */
  pageFacts?: Record<string, unknown>
  pageFactsDelta?: {
    changed: Record<string, unknown>
    removedKeys: string[]
  }
  staleRefs?: boolean
  artifactRef?: string
  /** Whether every captured field for this observation is present in the inline tool result. */
  inlineComplete?: boolean
  /** Whether the artifact contains a complete snapshot and page-fact extraction. */
  artifactComplete?: boolean
  /** Size of the complete captured observation before transparent transport fallback. */
  sourceByteLength?: number
  snapshotByteLength?: number
  pageFactsSummary?: AgentBrowserPageFactSectionSummary[]
  omittedInlineSections?: string[]
  nextActions?: Array<'find' | 'html' | 'read-section'>
  /** Legacy/helper signal that a lower layer capped ARIA before artifact persistence. */
  snapshotExcerpted?: boolean
  /** The host could not retain or extract the complete evidence needed to assess this observation. */
  evidenceIncomplete?: boolean
  /** Legacy/internal transport signal. Agent-facing adapters must translate this to the fields above. */
  truncated?: boolean
  cached?: boolean
  [key: string]: unknown
}

export class ScrapeBrowserObservationPendingError extends Error {
  readonly code = 'BROWSER_OBSERVATION_PENDING' as const
  readonly url: string
  readonly documentRevision: string

  constructor(input: { url?: string; documentRevision: string }) {
    super('页面暂时无法生成 observation，请稍后调用一次 snapshot')
    this.name = 'ScrapeBrowserObservationPendingError'
    this.url = input.url ?? ''
    this.documentRevision = input.documentRevision
  }
}

export class ScrapeBrowserActionUncertainError extends Error {
  readonly code = 'BROWSER_ACTION_UNCERTAIN' as const
  readonly url: string
  readonly documentRevision: string

  constructor(input: { url?: string; documentRevision: string; cause?: unknown }) {
    super('浏览器动作返回错误，但文档已发生导航；请用 snapshot 或 status 确认状态，禁止重复动作', {
      cause: input.cause
    })
    this.name = 'ScrapeBrowserActionUncertainError'
    this.url = input.url ?? ''
    this.documentRevision = input.documentRevision
  }
}

export function isScrapeBrowserObservationPendingError(
  error: unknown
): error is ScrapeBrowserObservationPendingError {
  return (error as { code?: unknown } | null)?.code === 'BROWSER_OBSERVATION_PENDING'
}

export function isScrapeBrowserActionUncertainError(
  error: unknown
): error is ScrapeBrowserActionUncertainError {
  return (error as { code?: unknown } | null)?.code === 'BROWSER_ACTION_UNCERTAIN'
}

export type PluginBrowserAction =
  | 'snapshot'
  | 'inspect'
  | 'click'
  | 'type'
  | 'press'
  | 'waitForSelector'
  | 'wait'
  | 'html'
  | 'htmlRegion'
  | 'evaluate'
  | 'status'
  | 'url'

export type ScrapeBrowserPurpose = 'scrape' | 'plugin-check' | 'agent-browser'
