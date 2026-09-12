import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ScanCompletionResult } from './libraryTypes'
import { buildLibraryScanNotification } from './libraryScanNotification'

function result(patch: Partial<ScanCompletionResult> = {}): ScanCompletionResult {
  return {
    libraryId: 1,
    runId: 'run-1',
    scannedFiles: 0,
    imported: 0,
    skipped: 0,
    skippedShort: 0,
    failed: 0,
    pendingGroups: 0,
    pendingResources: 0,
    relocated: 0,
    refreshed: 0,
    removed: 0,
    promoted: 0,
    deletedVideos: 0,
    offlineFolders: [],
    unrecognizedCount: 0,
    strmFailures: [],
    omittedStrmFailures: 0,
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
    assert.match(notification?.message ?? '', /新增 2.*更新 1.*移除 3.*提升主资源 1.*移出无资源成员 4/)
  })

  it('reports a metadata-only resource refresh as an update', () => {
    assert.deepEqual(buildLibraryScanNotification(result({ refreshed: 2 })), {
      message: '扫描完成：新增 0，更新 2，移除 0，提升主资源 0，移出无资源成员 0',
      tone: 'success'
    })
  })

  it('reports pending scan groups and their resource count before ordinary changes', () => {
    assert.deepEqual(
      buildLibraryScanNotification(
        result({ pendingGroups: 2, pendingResources: 5, imported: 1 })
      ),
      {
        message: '扫描完成：2 个待确认扫描组，共 5 条资源',
        tone: 'warning'
      }
    )
  })

  it('prioritizes offline and error outcomes over ordinary change notices', () => {
    assert.equal(
      buildLibraryScanNotification(result({ offlineFolders: ['/offline'], imported: 1 }))?.tone,
      'warning'
    )
    assert.equal(buildLibraryScanNotification(result({ failed: 1 }))?.tone, 'warning')
  })

  it('reports isolated STRM failures without exposing target content', () => {
    const notification = buildLibraryScanNotification(
      result({
        failed: 3,
        unrecognizedCount: 1,
        strmFailures: [
          { sourcePath: '/library/A.strm', code: 'missing_target', message: 'STRM 中没有可用目标' }
        ],
        omittedStrmFailures: 1
      })
    )

    assert.equal(notification?.tone, 'warning')
    assert.match(notification?.message ?? '', /2 个 STRM 文件处理失败.*另有 1 个文件无法识别/)
    assert.doesNotMatch(notification?.message ?? '', /https?:\/\//)
  })

  it('reports a blocking processing failure before isolated STRM failures', () => {
    const notification = buildLibraryScanNotification(
      result({
        failed: 2,
        strmFailures: [
          { sourcePath: '/library/A.strm', code: 'read_failed', message: '无法读取 STRM 文件' }
        ]
      })
    )

    assert.deepEqual(notification, {
      message: '扫描失败：1 个文件处理失败，已跳过资源清理',
      tone: 'warning'
    })
    assert.match(
      buildLibraryScanNotification(
        result({ failed: 1, offlineFolders: ['/offline'] })
      )?.message ?? '',
      /扫描失败/
    )
  })

  it('classifies large compact counts without retaining paths or treating unknown files as processing failures', () => {
    const compact = result({ scannedFiles: 600000, failed: 600000, unrecognizedCount: 600000 })
    assert.equal(Object.hasOwn(compact, 'newCodes'), false)
    assert.equal(Object.hasOwn(compact, 'unrecognizedFiles'), false)
    assert.deepEqual(buildLibraryScanNotification(compact), {
      message: '扫描完成：600000 个文件无法识别，请查看待处理列表', tone: 'warning'
    })
    assert.deepEqual(buildLibraryScanNotification({ ...compact, failed: 600001 }), {
      message: '扫描失败：1 个文件处理失败，已跳过资源清理', tone: 'warning'
    })
    assert.deepEqual(buildLibraryScanNotification({ ...compact, cancelled: true, imported: 2 }), {
      message: '扫描已取消：已扫描 600000 个文件，新增 2 条资源', tone: 'info'
    })
  })
})
