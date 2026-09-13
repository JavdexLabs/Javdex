import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeNfoExportMessage } from './nfoExportSafety'

describe('NFO export renderer diagnostics', () => {
  it('redacts POSIX and Windows absolute paths while preserving the reason', () => {
    assert.equal(
      sanitizeNfoExportMessage(new Error("EACCES: open '/Users/person/private/movie.nfo'")),
      "EACCES: open '[本地路径]'"
    )
    assert.equal(
      sanitizeNfoExportMessage('EPERM C:\\Media\\secret\\movie.nfo'),
      'EPERM [本地路径]'
    )
    assert.equal(
      sanitizeNfoExportMessage("ENOENT: open '/srv/media/My Movie/movie.nfo'"),
      "ENOENT: open '[本地路径]'"
    )
    assert.equal(
      sanitizeNfoExportMessage("EACCES: open '\\\\server\\share\\Private Movie\\movie.nfo'"),
      "EACCES: open '[本地路径]'"
    )
    assert.equal(
      sanitizeNfoExportMessage("EPERM: open '\\\\?\\C:\\Media\\movie.nfo'"),
      "EPERM: open '[本地路径]'"
    )
  })
})
