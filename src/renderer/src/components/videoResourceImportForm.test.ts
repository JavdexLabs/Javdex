import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildVideoResourceImportInput, resourceBytesToFormSize } from './videoResourceImportForm'

describe('video resource import form', () => {
  it('shares auto detection, normalization, and size conversion across entry points', () => {
    assert.deepEqual(
      buildVideoResourceImportInput({
        code: ' ABC-123 ',
        url: 'HTTPS://CDN.Example:443/movie.mp4?b=2&a=1#preview',
        kind: 'auto',
        displayName: ' Remote ',
        size: '1.5',
        sizeUnit: 'GB'
      }),
      {
        code: 'ABC-123',
        url: 'https://cdn.example/movie.mp4?b=2&a=1',
        kind: 'direct',
        displayName: 'Remote',
        sizeBytes: 1610612736
      }
    )
    assert.deepEqual(resourceBytesToFormSize(1610612736), { value: '1.5', unit: 'GB' })
  })

  it('auto-detects Magnet and keeps its protocol-derived default name', () => {
    assert.deepEqual(
      buildVideoResourceImportInput({
        code: 'MAG-001',
        url: 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Example%20Movie',
        kind: 'auto',
        displayName: '',
        size: '',
        sizeUnit: 'GB'
      }),
      {
        code: 'MAG-001',
        url: 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Example%20Movie',
        kind: 'magnet',
        displayName: 'Example Movie',
        sizeBytes: null
      }
    )
  })
})
