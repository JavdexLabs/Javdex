import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ACTRESS_RESULT_KEY_CONTRACTS,
  VIDEO_RESULT_KEY_CONTRACTS,
  pluginResultContract
} from './pluginResultContract'
import { ALL_ACTRESS_SCRAPE_FIELDS } from './actressScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from './videoScrapeTypes'

describe('PluginResultContractModule', () => {
  it('classifies every structural and selectable result key by kind', () => {
    assert.deepEqual(VIDEO_RESULT_KEY_CONTRACTS.code, {
      key: 'code', role: 'identity', fieldIds: [], projection: 'always'
    })
    assert.deepEqual(VIDEO_RESULT_KEY_CONTRACTS.sourceUrl.fieldIds, ['source'])
    assert.deepEqual(VIDEO_RESULT_KEY_CONTRACTS.actresses, {
      key: 'actresses',
      role: 'field',
      fieldIds: ['actressesFemale', 'actressesMale'],
      projection: 'selected',
      partition: 'gender'
    })
    assert.deepEqual(ACTRESS_RESULT_KEY_CONTRACTS.mainName, {
      key: 'mainName', role: 'identity', fieldIds: [], projection: 'plugin-only'
    })
    assert.deepEqual(ACTRESS_RESULT_KEY_CONTRACTS.sourceUrl, {
      key: 'sourceUrl', role: 'diagnostic', fieldIds: [], projection: 'plugin-only'
    })
  })

  it('projects every manifest field through at least one standard result key', () => {
    const videoFields = new Set(Object.values(VIDEO_RESULT_KEY_CONTRACTS).flatMap((item) => item.fieldIds))
    const actressFields = new Set(Object.values(ACTRESS_RESULT_KEY_CONTRACTS).flatMap((item) => item.fieldIds))
    assert.deepEqual([...videoFields].sort(), [...ALL_VIDEO_SCRAPE_FIELDS].sort())
    assert.deepEqual([...actressFields].sort(), [...ALL_ACTRESS_SCRAPE_FIELDS].sort())
  })

  it('lists unknown raw keys once without guessing a field mapping', () => {
    assert.deepEqual(pluginResultContract.unrecognizedResultKeys('video', [
      { code: 'ABC-1', title: 'one', cover: 'a.jpg', debug: true },
      { code: 'ABC-1', title: 'two', cover: 'b.jpg', duration: 120 }
    ]), ['cover', 'debug', 'duration'])
  })

  it('keeps actress identity and source metadata informational', () => {
    const result = pluginResultContract.analyze({
      kind: 'actress',
      pluginResult: {
        mainName: '三上悠亜',
        sourceUrl: 'https://example.test/profile',
        aliases: ['Yua Mikami']
      },
      effectiveResult: { aliases: ['Yua Mikami'] },
      declaredFields: []
    })

    assert.deepEqual(result.manifestCoverage, {
      returnedFieldIds: ['aliases'],
      undeclaredReturnedFieldIds: ['aliases'],
      runtimeOnlyKeys: [
        { key: 'mainName', role: 'identity' },
        { key: 'sourceUrl', role: 'diagnostic' }
      ]
    })
    assert.equal(result.materialAccepted, true)
  })

  it('detects field-level partial cast projection and legacy female default', () => {
    const result = pluginResultContract.analyze({
      kind: 'video',
      pluginResult: {
        code: 'ABC-123',
        actresses: [
          { name: 'Alice' },
          { name: 'Beth', gender: 'female' },
          { name: 'Bob', gender: 'male' }
        ]
      },
      effectiveResult: {
        code: 'ABC-123',
        actresses: [{ name: 'Alice' }, { name: 'Beth', gender: 'female' }]
      },
      declaredFields: ['actressesFemale']
    })

    assert.deepEqual(result.manifestCoverage.returnedFieldIds, [
      'actressesFemale', 'actressesMale'
    ])
    assert.deepEqual(result.manifestCoverage.undeclaredReturnedFieldIds, [
      'actressesMale'
    ])
    assert.equal(result.materialAccepted, true)
  })

  it('maps composite measurements and rating to their legal manifest fields', () => {
    const actress = pluginResultContract.analyze({
      kind: 'actress',
      pluginResult: { waistCm: 58 },
      effectiveResult: { waistCm: 58 },
      declaredFields: []
    })
    const video = pluginResultContract.analyze({
      kind: 'video',
      pluginResult: { code: 'ABC-123', ratingAverage: 4.2, ratingCount: 100 },
      effectiveResult: { code: 'ABC-123', ratingAverage: 4.2, ratingCount: 100 },
      declaredFields: []
    })

    assert.deepEqual(actress.manifestCoverage.returnedFieldIds, ['measurements'])
    assert.deepEqual(actress.manifestCoverage.undeclaredReturnedFieldIds, ['measurements'])
    assert.deepEqual(video.manifestCoverage.returnedFieldIds, ['rating'])
    assert.deepEqual(video.manifestCoverage.undeclaredReturnedFieldIds, ['rating'])
  })

  it('rejects empty and identity-only effective results mechanically', () => {
    for (const effectiveResult of [
      {},
      { avatarUrl: undefined },
      { aliases: [] },
      { code: 'ABC-123' },
      { code: 'ABC-123', sourceUrl: 'https://example.test/video' },
      { mainName: 'Alice', sourceUrl: 'https://example.test/profile' }
    ]) {
      const kind = Object.hasOwn(effectiveResult, 'code') ? 'video' : 'actress'
      const result = pluginResultContract.analyze({
        kind,
        pluginResult: effectiveResult,
        effectiveResult,
        declaredFields: []
      })
      assert.equal(result.materialAccepted, false)
    }
  })
})
