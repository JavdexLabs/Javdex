import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertPlaylistImportFinalAdvance,
  assertPlaylistImportTerminalVerified,
  assertPlaylistImportVirtualStart,
  observePlaylistImportDynamicStability,
  playlistImportRecoveryFailureCode,
  playlistImportVirtualAdvanceDecision,
  playlistImportTerminalProof,
  shouldAutoRecoverPlaylistImportRun,
  shouldValidatePlaylistImportAdvanceAtCheckpoint,
  shouldValidatePlaylistImportBrowserLocation
} from './playlistImportBrowserNavigation'

describe('playlist import browser navigation guard', () => {
  it('does not overwrite a terminating handoff result after a login redirect', () => {
    assert.equal(shouldValidatePlaylistImportBrowserLocation('handoff', {
      ok: true,
      content: '{"code":"USER_INPUT_REQUIRED"}',
      summary: '等待用户完成浏览器操作',
      terminate: true
    }), false)
  })

  it('keeps every user-attention state paused across application restart', () => {
    assert.equal(shouldAutoRecoverPlaylistImportRun({
      phase: 'waiting_user',
      attention: {
        kind: 'browser-handoff',
        requestId: 'handoff-1',
        reason: 'login',
        prompt: '请登录'
      }
    }), false)
    assert.equal(shouldAutoRecoverPlaylistImportRun({
      phase: 'waiting_user',
      attention: { kind: 'identity-review', items: [] }
    }), false)
    assert.equal(shouldAutoRecoverPlaylistImportRun({
      phase: 'discovering-list',
      attention: undefined
    }), true)
  })

  it('still validates ordinary browser actions that can change the current page', () => {
    assert.equal(shouldValidatePlaylistImportBrowserLocation('status', {
      ok: true,
      content: '{}',
      summary: '浏览器 status 完成'
    }), true)
    assert.equal(shouldValidatePlaylistImportBrowserLocation('open', {
      ok: true,
      content: '{}',
      summary: '浏览器 open 完成'
    }), false)
  })

  it('requires DOM-backed terminal reasons to carry a selector and pass host verification', () => {
    assert.deepEqual(playlistImportTerminalProof({
      kind: 'terminal',
      reason: 'disabled-next',
      selector: '.pagination .next'
    }), {
      kind: 'disabled-next',
      selector: '.pagination .next'
    })
    assert.throws(
      () => playlistImportTerminalProof({ kind: 'terminal', reason: 'disabled-next' }),
      /PLAYLIST_IMPORT_ARGUMENT_REQUIRED:selector/
    )
    assert.throws(() => assertPlaylistImportTerminalVerified({
      advance: {
        kind: 'terminal',
        reason: 'no-pagination-container-after-full-dom-check',
        selector: '.pagination'
      },
      terminalVerified: false
    }), /PLAYLIST_IMPORT_TERMINAL_UNPROVEN/)
  })

  it('accepts known-total terminal evidence only when the checkpoint declares a total', () => {
    assert.throws(() => assertPlaylistImportTerminalVerified({
      advance: { kind: 'terminal', reason: 'known-total-reached' }
    }), /PLAYLIST_IMPORT_TERMINAL_TOTAL_REQUIRED/)
    assert.doesNotThrow(() => assertPlaylistImportTerminalVerified({
      advance: { kind: 'terminal', reason: 'known-total-reached' },
      declaredTotalPages: 3
    }))
  })

  it('accepts a virtual first window only after a settled host-owned reset to the top', () => {
    assert.doesNotThrow(() => assertPlaylistImportVirtualStart({ atStart: true, settled: true }))
    assert.throws(
      () => assertPlaylistImportVirtualStart({ atStart: false, settled: true }),
      /VIRTUAL_LIST_START_UNPROVEN/
    )
    assert.throws(
      () => assertPlaylistImportVirtualStart({ atStart: true, settled: false }),
      /VIRTUAL_LIST_START_UNPROVEN/
    )
  })

  it('revalidates terminal or link evidence in the final dynamic window before sealing', () => {
    assert.throws(() => assertPlaylistImportFinalAdvance({
      advance: {
        kind: 'terminal',
        reason: 'explicit-last-page',
        selector: '.pagination .last.current'
      },
      terminalVerified: false,
      nextPageCount: 0
    }), /PLAYLIST_IMPORT_TERMINAL_UNPROVEN/)
    assert.throws(() => assertPlaylistImportFinalAdvance({
      advance: { kind: 'next-link', selector: '.pagination .next' },
      nextPageCount: 0
    }), /PLAYLIST_IMPORT_NEXT_PAGE_NOT_FOUND/)
    assert.doesNotThrow(() => assertPlaylistImportFinalAdvance({
      advance: { kind: 'next-link', selector: '.pagination .next' },
      nextPageCount: 1
    }))
    assert.throws(() => assertPlaylistImportFinalAdvance({
      advance: { kind: 'terminal', reason: 'load-more-control-exhausted' },
      loadMoreAvailable: true,
      nextPageCount: 0
    }), /PLAYLIST_IMPORT_LOAD_MORE_NOT_EXHAUSTED/)
    assert.doesNotThrow(() => assertPlaylistImportFinalAdvance({
      advance: { kind: 'terminal', reason: 'load-more-control-exhausted' },
      loadMoreAvailable: false,
      nextPageCount: 0
    }))
  })

  it('alternates virtual scrolling with frozen load-more actions before sealing', () => {
    assert.equal(playlistImportVirtualAdvanceDecision({
      terminalProbeCount: 1,
      hasLoadMoreContract: true,
      loadMoreAvailable: true
    }), 'scroll')
    assert.equal(playlistImportVirtualAdvanceDecision({
      terminalProbeCount: 2,
      hasLoadMoreContract: true,
      loadMoreAvailable: true
    }), 'load-more')
    assert.equal(playlistImportVirtualAdvanceDecision({
      terminalProbeCount: 2,
      hasLoadMoreContract: true,
      loadMoreAvailable: false
    }), 'seal')
  })

  it('defers bottom-only advance validation until a virtual page reaches its terminal view', () => {
    for (const advance of [
      { kind: 'load-more' },
      { kind: 'next-link' },
      { kind: 'terminal', reason: 'disabled-next' }
    ]) {
      assert.equal(
        shouldValidatePlaylistImportAdvanceAtCheckpoint('virtual-page-start', advance),
        false
      )
    }
    assert.equal(shouldValidatePlaylistImportAdvanceAtCheckpoint('static-page', {
      kind: 'next-link'
    }), true)
    assert.equal(shouldValidatePlaylistImportAdvanceAtCheckpoint('virtual-page-start', {
      kind: 'terminal',
      reason: 'known-total-reached'
    }), true)
  })

  it('waits for a quiet window after every asynchronous load-more change', () => {
    const state = { progressObserved: false } as const
    let observed = observePlaylistImportDynamicStability({
      state,
      progressed: true,
      signature: 'one-new-item:disabled',
      observedAt: 0
    })
    assert.equal(observed.settled, false)

    observed = observePlaylistImportDynamicStability({
      state: observed.state,
      progressed: true,
      signature: 'two-new-items:enabled',
      observedAt: 600
    })
    assert.equal(observed.settled, false)

    observed = observePlaylistImportDynamicStability({
      state: observed.state,
      progressed: true,
      signature: 'two-new-items:enabled',
      observedAt: 1_599
    })
    assert.equal(observed.settled, false)
    assert.equal(observePlaylistImportDynamicStability({
      state: observed.state,
      progressed: true,
      signature: 'two-new-items:enabled',
      observedAt: 1_600
    }).settled, true)
  })

  it('restarts the quiet window when a temporary dynamic expansion rolls back', () => {
    let observed = observePlaylistImportDynamicStability({
      state: { progressObserved: false },
      progressed: true,
      signature: 'temporary-expansion',
      observedAt: 0
    })
    observed = observePlaylistImportDynamicStability({
      state: observed.state,
      progressed: false,
      signature: 'rolled-back',
      observedAt: 100
    })
    assert.equal(observed.settled, false)
    assert.equal(observePlaylistImportDynamicStability({
      state: observed.state,
      progressed: false,
      signature: 'rolled-back',
      observedAt: 1_100
    }).settled, false)

    observed = observePlaylistImportDynamicStability({
      state: observed.state,
      progressed: true,
      signature: 'real-expansion',
      observedAt: 1_200
    })
    assert.equal(observePlaylistImportDynamicStability({
      state: observed.state,
      progressed: true,
      signature: 'real-expansion',
      observedAt: 2_200
    }).settled, true)
  })

  it('reports recovery budget exhaustion separately from source changes', () => {
    assert.equal(
      playlistImportRecoveryFailureCode(new Error('LIMIT_REACHED:VIRTUAL_REPLAY')),
      'LIMIT_REACHED'
    )
    assert.equal(
      playlistImportRecoveryFailureCode(new Error('SOURCE_CHANGED:VIRTUAL_PREFIX')),
      'SOURCE_CHANGED'
    )
    assert.equal(
      playlistImportRecoveryFailureCode(new Error('工具执行超时')),
      'NETWORK_TIMEOUT'
    )
    assert.equal(
      playlistImportRecoveryFailureCode(new Error('Agent 元数据浏览器会话不存在。')),
      'BROWSER_SESSION_LOST'
    )
  })
})
