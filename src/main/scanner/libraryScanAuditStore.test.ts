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
    trigger: 'manual',
    startedAt: '2026-08-24T01:00:00.000Z',
    finishedAt: '2026-08-24T01:00:01.000Z',
    status: 'success',
    files: [{ filePath: 'D:\\Media\\A-001.mp4', sourceKind: 'local', outcome: 'unrecognized' }],
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

    assert.deepEqual(readLibraryScanAudit(), value)
    assert.equal(libraryScanAuditContainsPath(value, 'd:\\media\\A-001.mp4'), true)
  })

  it('fails closed for malformed audit documents', () => {
    fs.writeFileSync(path.join(tempRoot, 'library-scan-audit.json'), '{"schemaVersion":1}')
    assert.equal(readLibraryScanAudit(), null)
  })
})
