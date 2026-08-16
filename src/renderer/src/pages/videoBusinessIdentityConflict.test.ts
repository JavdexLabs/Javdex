import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isVideoBusinessIdentityConflictError } from './videoBusinessIdentityConflict'

describe('video business identity conflict presentation', () => {
  it('recognizes domain and database-boundary conflict messages', () => {
    assert.equal(
      isVideoBusinessIdentityConflictError(new Error('影片业务身份与影片 ID 9 冲突')),
      true
    )
    assert.equal(
      isVideoBusinessIdentityConflictError(
        new Error("UNIQUE constraint failed: index 'idx_videos_business_identity'")
      ),
      true
    )
    assert.equal(
      isVideoBusinessIdentityConflictError(
        new Error(
          'UNIQUE constraint failed: videos.publisher_organization_id, videos.code, videos.release_date'
        )
      ),
      true
    )
    assert.equal(isVideoBusinessIdentityConflictError(new Error('网络错误')), false)
  })
})
