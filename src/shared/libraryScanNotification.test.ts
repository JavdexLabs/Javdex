import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ScanResult } from './libraryTypes'
import { buildLibraryScanNotification } from './libraryScanNotification'

function result(patch: Partial<ScanResult> = {}): ScanResult {
  return {
    scannedFiles: 0,
    imported: 0,
    skipped: 0,
    skippedShort: 0,
    failed: 0,
    relocated: 0,
    removed: 0,
    promoted: 0,
    deletedVideos: 0,
    offlineFolders: [],
    newCodes: [],
    unrecognizedFiles: [],
    ...patch
  }
}

describe('buildLibraryScanNotification', () => {
  it('keeps a no-change successful scan quiet', () => {
    assert.equal(buildLibraryScanNotification(result()), null)
  })

  it('notifies for changes and reports each destructive count separately', () => {
    const notification = buildLibraryScanNotification(
      result({ imported: 2, relocated: 1, removed: 3, promoted: 1, deletedVideos: 4 })
    )
    assert.equal(notification?.tone, 'success')
    assert.match(notification?.message ?? '', /新增 2.*更新 1.*移除 3.*提升主资源 1.*删除影片 4/)
  })

  it('prioritizes offline and error outcomes over ordinary change notices', () => {
    assert.equal(
      buildLibraryScanNotification(result({ offlineFolders: ['/offline'], imported: 1 }))?.tone,
      'warning'
    )
    assert.equal(buildLibraryScanNotification(result({ failed: 1 }))?.tone, 'warning')
  })
})
