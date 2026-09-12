import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  withVideoBatchFilterScope,
  withVideoBatchRequestScope
} from './videoBatchScope'

describe('video batch request scope', () => {
  it('requires and preserves the current library on library-surface requests', () => {
    assert.deepEqual(
      withVideoBatchRequestScope(
        { kind: 'library', libraryId: 7 },
        { status: 'all', videoIds: [11, 12], fields: ['title'] }
      ),
      { libraryId: 7, status: 'all', videoIds: [11, 12], fields: ['title'] }
    )
    assert.deepEqual(
      withVideoBatchFilterScope(
        { kind: 'library', libraryId: 7 },
        { status: 0, missingFields: [] }
      ),
      { libraryId: 7, status: 0, missingFields: [] }
    )
    assert.throws(
      () =>
        withVideoBatchRequestScope(
          { kind: 'library', libraryId: 0 },
          { status: 0, fields: ['title'] }
        ),
      /媒体库 ID 必须是正整数/
    )
  })

  it('keeps application-settings requests in explicit global compatibility mode', () => {
    assert.deepEqual(
      withVideoBatchRequestScope(
        { kind: 'all' },
        { status: 0, fields: ['title'], mode: 'fillEmpty' }
      ),
      { status: 0, fields: ['title'], mode: 'fillEmpty' }
    )
  })
})
