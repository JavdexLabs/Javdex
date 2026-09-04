import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  DEFAULT_MEDIA_LIBRARY_CONFIG,
  type MediaLibraryDetail
} from '@shared/mediaLibraryTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { api: { scan: { revealAuditFile: async () => ({ ok: true }) } } }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('')
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

const library = {
  id: 1,
  name: '测试媒体库',
  icon: 'library',
  color: 'slate',
  position: 0,
  status: 'active',
  isDefault: true,
  revision: 1,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  config: { libraryId: 1, revision: 1, ...DEFAULT_MEDIA_LIBRARY_CONFIG },
  roots: [],
  rootCount: 0,
  activeRootCount: 0,
  pendingRemovalRootCount: 0,
  pendingCleanupJobCount: 0,
  pendingScanGroupCount: 0,
  disabledRootCount: 0,
  archivedRootCount: 0
} satisfies MediaLibraryDetail

describe('ScanSettingsTab', () => {
  it('builds domain-correct deep links for scan identities and scrape candidates', async () => {
    const { scanAuditPendingCenterPath } = await import('./MediaLibrarySettingsTabs')
    assert.equal(
      scanAuditPendingCenterPath(7, { domain: 'scan', id: 'identity-4' }),
      '/pending?type=scan&item=scan%3Aidentity-4&lib=7'
    )
    assert.equal(
      scanAuditPendingCenterPath(7, { domain: 'scrape', id: '8' }),
      '/pending?type=scrape&item=scrape%3A8'
    )
  })

  it('renders automatic local NFO import enabled by default and persists a switch change immediately', async () => {
    const { ScanSettingsTab } = await import('./MediaLibrarySettingsTabs')
    const updates: Array<[string, unknown]> = []
    act(() => {
      renderer = TestRenderer.create(
        <ScanSettingsTab
          libraryId={library.id}
          library={library}
          scan={{
            running: false,
            cancelling: false,
            activeRunId: null,
            progress: null,
            error: null,
            latest: null,
            start: async () => undefined,
            cancel: async () => undefined,
            refreshLatest: async () => undefined
          } as never}
          latestScanSummary={null}
          pendingScanGroupIds={new Set()}
          pendingResourceIdentityIds={new Set()}
          pendingVideoScrapeIds={new Set()}
          selectedScanMetric={null}
          setSelectedScanMetric={() => undefined}
          configDraft={DEFAULT_MEDIA_LIBRARY_CONFIG}
          updateConfigImmediately={async (key, value) => {
            updates.push([key, value])
          }}
          formDisabled={false}
          navigate={() => undefined}
        />
      )
    })

    const row = renderer!.root
      .findAllByType('label')
      .find((candidate) => nodeText(candidate).includes('自动导入本地 NFO'))
    assert.ok(row)
    const input = row.findByProps({ role: 'switch' })
    assert.equal(input.props.checked, true)

    await act(async () => {
      input.props.onChange({ target: { checked: false } })
      await Promise.resolve()
    })

    assert.deepEqual(updates, [['autoImportLocalNfo', false]])
  })
})
