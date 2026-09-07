import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LibraryScanAudit } from '@shared/libraryTypes'
import {
  libraryScanAuditContainsPath,
  readLibraryScanAudit,
  writeLibraryScanAudit
} from './libraryScanAuditStore'

let tempRoot = ''
let previousUserData: string | undefined

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scan-audit-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
})

afterEach(() => {
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function audit(): LibraryScanAudit {
  return {
    schemaVersion: 1,
    libraryId: 1,
    runId: 'scan-audit-test',
    configRevision: 1,
    trigger: 'manual',
    startedAt: '2026-08-24T01:00:00.000Z',
    finishedAt: '2026-08-24T01:00:01.000Z',
    status: 'success',
    files: [
      {
        rootId: 1,
        filePath: 'D:\\Media\\A-001.mp4',
        sourceKind: 'local',
        outcome: 'unrecognized'
      }
    ],
    removedResources: [],
    promotedResources: [],
    deletedVideos: [],
    pendingGroups: []
  }
}

describe('libraryScanAuditStore', () => {
  it('atomically replaces and restores the complete latest audit', () => {
    const value = audit()
    writeLibraryScanAudit(value)

    assert.deepEqual(readLibraryScanAudit(1), value)
    assert.equal(readLibraryScanAudit(2), null)
    assert.equal(libraryScanAuditContainsPath(value, 'd:\\media\\A-001.mp4'), true)
  })

  it('fails closed for malformed audit documents', () => {
    fs.writeFileSync(path.join(tempRoot, 'library-scan-audit-1.json'), '{"schemaVersion":1}')
    assert.equal(readLibraryScanAudit(1), null)
  })

  it('reads schema 2 NFO dispositions while retaining schema 1 compatibility', () => {
    const value: LibraryScanAudit = {
      ...audit(),
      schemaVersion: 2,
      files: [
        {
          rootId: 1,
          filePath: 'D:\\Media\\NFO-001.mp4',
          sourceKind: 'local',
          outcome: 'added',
          videoId: 10,
          videoCode: 'NFO-001',
          resourceId: 20,
          resourceKind: 'local',
          createdVideo: true,
          nfo: {
            disposition: 'warning',
            warnings: [{ code: 'nfo-warning', message: '远程图片已忽略' }]
          }
        }
      ]
    }
    writeLibraryScanAudit(value)
    assert.deepEqual(readLibraryScanAudit(1), value)

    fs.writeFileSync(
      path.join(tempRoot, 'library-scan-audit-2.json'),
      JSON.stringify({ ...value, libraryId: 2, files: [{ ...value.files[0], nfo: { disposition: 'bad' } }] })
    )
    assert.equal(readLibraryScanAudit(2), null)
  })
})
