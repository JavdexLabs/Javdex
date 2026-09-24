import type {
  AgentBrowserScrollState,
  ScrapeBrowserListExtractionPlan
} from '../../scrapers/scrapeBrowserTypes'

type TerminalAdvance = Record<string, unknown>

export function playlistImportTerminalProof(
  advance: TerminalAdvance
): ScrapeBrowserListExtractionPlan['terminalProof'] | undefined {
  if (advance.kind !== 'terminal') return undefined
  if (advance.reason === 'known-total-reached') return undefined
  if (![
    'disabled-next',
    'explicit-last-page',
    'no-pagination-container-after-full-dom-check'
  ].includes(String(advance.reason))) {
    throw new Error('PLAYLIST_IMPORT_ARGUMENT_INVALID:reason')
  }
  const selector = typeof advance.selector === 'string' ? advance.selector.trim() : ''
  if (!selector) throw new Error('PLAYLIST_IMPORT_ARGUMENT_REQUIRED:selector')
  return {
    kind: advance.reason as NonNullable<ScrapeBrowserListExtractionPlan['terminalProof']>['kind'],
    selector
  }
}

export function assertPlaylistImportTerminalVerified(input: {
  advance: TerminalAdvance
  terminalVerified?: boolean
  declaredTotalItems?: number
  declaredTotalPages?: number
}): void {
  if (input.advance.kind !== 'terminal') return
  if (input.advance.reason === 'known-total-reached') {
    if (input.declaredTotalItems == null && input.declaredTotalPages == null) {
      throw new Error('PLAYLIST_IMPORT_TERMINAL_TOTAL_REQUIRED')
    }
    return
  }
  playlistImportTerminalProof(input.advance)
  if (input.terminalVerified !== true) {
    throw new Error(
      'PLAYLIST_IMPORT_TERMINAL_UNPROVEN: selector 未满足当前终止原因的机械验证条件；' +
      'explicit-last-page 必须命中可见的明确末页标记，不能使用缺失的下一页 selector。'
    )
  }
}

export function assertPlaylistImportFinalAdvance(input: {
  advance: TerminalAdvance
  terminalVerified?: boolean
  loadMoreAvailable?: boolean
  nextPageCount: number
}): void {
  if (input.advance.kind === 'terminal') {
    if (input.advance.reason === 'load-more-control-exhausted') {
      if (input.loadMoreAvailable === true) {
        throw new Error('PLAYLIST_IMPORT_LOAD_MORE_NOT_EXHAUSTED')
      }
      return
    }
    if (input.advance.reason !== 'known-total-reached') {
      assertPlaylistImportTerminalVerified({
        advance: input.advance,
        terminalVerified: input.terminalVerified
      })
    }
    return
  }
  if (
    ['next-link', 'numbered-links'].includes(String(input.advance.kind)) &&
    input.nextPageCount === 0
  ) {
    throw new Error('PLAYLIST_IMPORT_NEXT_PAGE_NOT_FOUND')
  }
}

export function shouldValidatePlaylistImportAdvanceAtCheckpoint(
  checkpointKind: string,
  advance: TerminalAdvance
): boolean {
  return checkpointKind !== 'virtual-page-start' || advance.reason === 'known-total-reached'
}

export type PlaylistImportVirtualAdvanceDecision = 'scroll' | 'load-more' | 'seal'

export const PLAYLIST_IMPORT_DYNAMIC_QUIET_WINDOW_MS = 1_000

export interface PlaylistImportDynamicStabilityState {
  progressObserved: boolean
  signature?: string
  stableSince?: number
}

export function observePlaylistImportDynamicStability(input: {
  state: PlaylistImportDynamicStabilityState
  progressed: boolean
  signature: string
  observedAt: number
  quietWindowMs?: number
}): { state: PlaylistImportDynamicStabilityState; settled: boolean } {
  const progressObserved = input.state.progressObserved || input.progressed
  if (!input.progressed) {
    return { state: { progressObserved }, settled: false }
  }
  if (input.state.signature !== input.signature || input.state.stableSince == null) {
    return {
      state: {
        progressObserved: true,
        signature: input.signature,
        stableSince: input.observedAt
      },
      settled: false
    }
  }
  const quietWindowMs = input.quietWindowMs ?? PLAYLIST_IMPORT_DYNAMIC_QUIET_WINDOW_MS
  return {
    state: input.state,
    settled: input.observedAt - input.state.stableSince >= quietWindowMs
  }
}

export function playlistImportFailureCode(
  error: unknown
): 'LIMIT_REACHED' | 'SOURCE_CHANGED' | 'NETWORK_TIMEOUT' | 'BROWSER_SESSION_LOST' | 'IMPORT_FAILED' {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('LIMIT_REACHED')) return 'LIMIT_REACHED'
  if (message.startsWith('SOURCE_CHANGED')) return 'SOURCE_CHANGED'
  if (isPlaylistImportBrowserSessionLostMessage(message)) {
    return 'BROWSER_SESSION_LOST'
  }
  if (/timeout|timed out|超时/iu.test(message)) return 'NETWORK_TIMEOUT'
  return 'IMPORT_FAILED'
}

export function isPlaylistImportBrowserSessionLostMessage(message: string): boolean {
  return (
    /浏览器会话不存在/u.test(message) ||
    /BROWSER(?:_|\s).*SESSION(?:_|\s).*(?:LOST|MISSING|CLOSED)/iu.test(message) ||
    /(?:target page|browser|context|ipc|cdp).*(?:closed|disconnected)/iu.test(message)
  )
}

export function playlistImportVirtualAdvanceDecision(input: {
  terminalProbeCount: number
  hasLoadMoreContract: boolean
  loadMoreAvailable?: boolean
}): PlaylistImportVirtualAdvanceDecision {
  if (input.terminalProbeCount < 2) return 'scroll'
  if (input.hasLoadMoreContract && input.loadMoreAvailable === true) return 'load-more'
  return 'seal'
}

export function assertPlaylistImportVirtualStart(
  scrollState: Pick<AgentBrowserScrollState, 'atStart' | 'settled'> | undefined,
  errorCode = 'VIRTUAL_LIST_START_UNPROVEN'
): void {
  if (!scrollState?.atStart || !scrollState.settled) throw new Error(errorCode)
}
