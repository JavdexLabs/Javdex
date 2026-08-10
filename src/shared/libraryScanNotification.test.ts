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
    refreshed: 0,
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

  it('reports a metadata-only resource refresh as an update', () => {
    assert.deepEqual(buildLibraryScanNotification(result({ refreshed: 2 })), {
      message: '扫描完成：新增 0，更新 2，移除 0，提升主资源 0，删除影片 0',
      tone: 'success'
    })
  })

  it('prioritizes offline and error outcomes over ordinary change notices', () => {
    assert.equal(
      buildLibraryScanNotification(result({ offlineFolders: ['/offline'], imported: 1 }))?.tone,
      'warning'
    )
    assert.equal(buildLibraryScanNotification(result({ failed: 1 }))?.tone, 'warning')
  })
})
