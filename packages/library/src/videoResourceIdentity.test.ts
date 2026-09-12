import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLocalPathIdentity } from './localPathIdentity'
import { buildVideoResourceSourceIdentity } from './videoResourceIdentity'

describe('video resource source identity', () => {
  it('normalizes local file paths', () => {
    assert.equal(
      buildVideoResourceSourceIdentity({
        kind: 'local',
        locator: '/Library/Movies/ABC-001.mp4'
      }),
      `local:${normalizeLocalPathIdentity('/Library/Movies/ABC-001.mp4')}`
    )
  })

  it('uses the STRM source file instead of its external target', () => {
    assert.equal(
      buildVideoResourceSourceIdentity({
        kind: 'web',
        locator: 'https://example.test/watch/ABC-001',
        strmSourcePath: '/Library/Movies/ABC-001.strm'
      }),
      `strm:${normalizeLocalPathIdentity('/Library/Movies/ABC-001.strm')}`
    )
  })

  it('does not claim ownership of ordinary external resources', () => {
    assert.equal(
      buildVideoResourceSourceIdentity({
        kind: 'direct',
        locator: 'https://cdn.example.test/ABC-001.mp4'
      }),
      null
    )
  })
})
