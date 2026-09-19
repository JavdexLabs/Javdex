import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildVideoManualImportInput,
  buildVideoResourceImportInput,
  canProbeDirectResourceSize,
  formatVideoResourceLinkCheck,
  normalizeOptionalVideoCode,
  resourceBytesToFormSize
} from './videoResourceImportForm'

describe('video resource import form', () => {
  it('shares auto detection, normalization, and size conversion across entry points', () => {
    assert.deepEqual(
      buildVideoResourceImportInput({
        code: ' abc-123 ',
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

  it('treats blank matching input as absent without invoking strict code validation', () => {
    assert.equal(normalizeOptionalVideoCode(''), null)
    assert.equal(normalizeOptionalVideoCode('   '), null)
    assert.equal(normalizeOptionalVideoCode(' abc-123 '), 'ABC-123')
  })

  it('allows registering a video without a playback url and keeps related links', () => {
    assert.deepEqual(
      buildVideoManualImportInput({
        code: ' empty-001 ',
        url: '  ',
        kind: 'auto',
        displayName: 'Ignored',
        size: '1',
        sizeUnit: 'GB',
        links: [
          { label: ' JavDB ', url: ' https://javdb.com/v/EMPTY-001 ' },
          { label: 'skip', url: '' }
        ]
      }),
      {
        code: 'EMPTY-001',
        links: [{ label: 'JavDB', url: 'https://javdb.com/v/EMPTY-001' }]
      }
    )
  })

  it('probes size only for direct video urls and does not claim playability', () => {
    assert.equal(canProbeDirectResourceSize('auto', 'https://github.com/JavdexLabs/Javdex'), false)
    assert.equal(canProbeDirectResourceSize('auto', 'https://cdn.example/movie.mp4'), true)
    assert.equal(canProbeDirectResourceSize('web', 'https://cdn.example/movie.mp4'), false)
    assert.equal(canProbeDirectResourceSize('direct', 'https://github.com/JavdexLabs/Javdex'), true)
    assert.equal(
      formatVideoResourceLinkCheck({ ok: true, status: 206, sizeBytes: 1024 }),
      '直链有响应 · HTTP 206 · 已填入文件大小'
    )
    assert.equal(
      formatVideoResourceLinkCheck({
        ok: false,
        error: '未能读取大小。站点可能拒绝探测请求，仍可导入。'
      }),
      '未能读取大小。站点可能拒绝探测请求，仍可导入。'
    )
  })

  it('collects multiple playback resources for a manual import', () => {
    assert.deepEqual(
      buildVideoManualImportInput({
        code: 'MULTI-001',
        resources: [
          {
            url: 'https://cdn.example/a.mp4',
            kind: 'direct',
            displayName: 'A',
            size: '',
            sizeUnit: 'GB'
          },
          {
            url: '  ',
            kind: 'auto',
            displayName: 'skip',
            size: '',
            sizeUnit: 'GB'
          },
          {
            url: 'https://example.com/watch',
            kind: 'auto',
            displayName: '',
            size: '',
            sizeUnit: 'GB'
          }
        ],
        links: []
      }),
      {
        code: 'MULTI-001',
        resources: [
          {
            url: 'https://cdn.example/a.mp4',
            kind: 'direct',
            displayName: 'A',
            sizeBytes: null
          },
          {
            url: 'https://example.com/watch',
            kind: 'web',
            displayName: null,
            sizeBytes: null
          }
        ]
      }
    )
  })
})
