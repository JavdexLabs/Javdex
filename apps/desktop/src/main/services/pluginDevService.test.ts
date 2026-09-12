import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import type { PluginDevDryRunResult } from '@shared/pluginDevTypes'
import { dryRunPluginPackage, normalizePackageForDev } from './pluginDevService'

let tempRoot: string | null = null
let oldUserData: string | null = null

beforeEach(() => {
  oldUserData = process.env.JAVDEX_TEST_USER_DATA ?? null
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-dev-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
})

afterEach(() => {
  if (oldUserData) {
    process.env.JAVDEX_TEST_USER_DATA = oldUserData
    oldUserData = null
  } else {
    delete process.env.JAVDEX_TEST_USER_DATA
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('pluginDevService', () => {
  it('preserves an explicit empty supportedFields list for an undiscovered create draft', () => {
    const base = {
      schemaVersion: 1 as const,
      kind: 'video' as const,
      name: 'undiscovered-video',
      code: 'module.exports = { async parseVideo() { return null } }'
    }

    assert.deepEqual(normalizePackageForDev({ ...base, supportedFields: [] }).supportedFields, [])
    assert.equal((normalizePackageForDev(base).supportedFields?.length ?? 0) > 0, true)
  })

  it('rejects parse result keys used as supportedFields instead of silently dropping them', () => {
    const packageWithResultKeys = {
      schemaVersion: 1 as const,
      kind: 'video' as const,
      name: 'invalid-supported-fields',
      supportedFields: [
        'title',
        'coverUrl',
        'durationSeconds',
        'actresses',
        'sourceUrl'
      ],
      code: 'module.exports = { async parseVideo() { return null } }'
    }

    assert.throws(
      () => normalizePackageForDev(packageWithResultKeys),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /supportedFields/)
        assert.match(message, /coverUrl[^\n]*cover/)
        assert.match(message, /durationSeconds[^\n]*duration/)
        assert.match(message, /actresses[^\n]*actressesFemale[^\n]*actressesMale/)
        assert.match(message, /sourceUrl[^\n]*source/)
        return true
      }
    )
  })

  it('wraps generated bare parseVideo functions before dry-run', async () => {
    const result = await dryRunPluginPackage({
      testTargets: ['PRED-877'],
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'bare-video',
        version: '1.0.0',
        supportedFields: ['title'],
        code: "async function parseVideo(ctx) { return { code: ctx.code, title: 'OK' } }"
      }
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.result, { code: 'PRED-877', title: 'OK' })
  })

  it('reports unrecognized raw result keys before normalization without suggestions', async () => {
    const result = await dryRunPluginPackage({
      testTarget: 'PRED-877',
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'unknown-video-result-keys',
        version: '1.0.0',
        supportedFields: ['title'],
        code: `async function parseVideo(ctx) {
  return {
    code: ctx.code,
    title: 'OK',
    cover: 'https://example.test/cover.jpg',
    duration: 120,
    source: 'https://example.test/video',
    samples: ['https://example.test/sample.jpg'],
    debug: true
  }
}
module.exports = { parseVideo }`
      }
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.pluginResult, { code: 'PRED-877', title: 'OK' })
    assert.deepEqual(
      (result as PluginDevDryRunResult & { unrecognizedResultKeys?: string[] }).unrecognizedResultKeys,
      ['cover', 'duration', 'source', 'samples', 'debug']
    )
    assert.equal(Object.hasOwn(result, 'suggestions'), false)
  })

  it('preserves every normalized video candidate during dry-run', async () => {
    const result = await dryRunPluginPackage({
      testTarget: 'PRED-877',
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'candidate-video',
        version: '1.0.0',
        supportedFields: ['title', 'releaseDate'],
        code: `async function parseVideo(ctx) {
  return [
    { code: ctx.code, title: 'First', releaseDate: '2026-05' },
    { code: ctx.code, title: 'Second', releaseDate: '2026-06-07' }
  ]
}
module.exports = { parseVideo }`
      }
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.result, [
      { code: 'PRED-877', title: 'First', releaseDate: '2026-05-01' },
      { code: 'PRED-877', title: 'Second', releaseDate: '2026-06-07' }
    ])
  })

  it('rejects a video result whose code does not match the requested target', async () => {
    const result = await dryRunPluginPackage({
      testTarget: 'PRED-877',
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'wrong-target-video',
        version: '1.0.0',
        supportedFields: ['title'],
        code: `async function parseVideo() {
  return { code: 'XYZ-999', title: 'Wrong video' }
}
module.exports = { parseVideo }`
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.result, null)
    assert.deepEqual(result.pluginResult, { code: 'XYZ-999', title: 'Wrong video' })
    assert.equal(result.effectiveResult, null)
    assert.deepEqual(result.targets, ['PRED-877'])
    assert.match(result.error ?? '', /与测试番号 PRED-877 不匹配/)
    assert.match(result.logs.join('\n'), /XYZ-999/)
  })

  it('wraps generated bare parseActress functions before dry-run', async () => {
    const result = await dryRunPluginPackage({
      testTarget: 'Alice',
      package: {
        schemaVersion: 1,
        kind: 'actress',
        name: 'bare-actress',
        version: '1.0.0',
        supportedFields: ['profileSummary'],
        code: "const parseActress = async (ctx) => ({ mainName: ctx.mainName, profileSummary: 'OK' })"
      }
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.pluginResult, { mainName: 'Alice', profileSummary: 'OK' })
    assert.deepEqual(result.effectiveResult, { profileSummary: 'OK' })
    assert.deepEqual(result.manifestCoverage, {
      returnedFieldIds: ['profileSummary'],
      undeclaredReturnedFieldIds: [],
      runtimeOnlyKeys: [{ key: 'mainName', role: 'identity' }]
    })
  })

  it('reports legal manifest field ids even when the compatibility projection accepts an empty declaration', async () => {
    const result = await dryRunPluginPackage({
      testTarget: 'Alice',
      package: {
        schemaVersion: 1,
        kind: 'actress',
        name: 'empty-manifest-actress',
        version: '1.0.0',
        supportedFields: [],
        code: `async function parseActress(ctx) {
  return { mainName: ctx.mainName, aliases: ['Ally'], sourceUrl: 'https://example.test/alice' }
}
module.exports = { parseActress }`
      }
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.manifestCoverage, {
      returnedFieldIds: ['aliases'],
      undeclaredReturnedFieldIds: ['aliases'],
      runtimeOnlyKeys: [
        { key: 'mainName', role: 'identity' },
        { key: 'sourceUrl', role: 'diagnostic' }
      ]
    })
  })

  it('coerces actress numeric and date strings during dry-run', async () => {
    const result = await dryRunPluginPackage({
      testTarget: 'Alice',
      package: {
        schemaVersion: 1,
        kind: 'actress',
        name: 'flex-actress',
        version: '1.0.0',
        supportedFields: ['heightCm', 'birthDate'],
        code: `async function parseActress(ctx) {
  return {
    mainName: ctx.mainName,
    heightCm: '160cm',
    birthDate: '1995-1-1'
  }
}
module.exports = { parseActress }`
      }
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.result, {
      heightCm: 160,
      birthDate: '1995-01-01'
    })
  })

  it('returns actress identity facts without adding a semantic target rejection', async () => {
    const result = await dryRunPluginPackage({
      testTarget: 'Alice',
      package: {
        schemaVersion: 1,
        kind: 'actress',
        name: 'wrong-actress',
        version: '1.0.0',
        supportedFields: ['profileSummary'],
        code: `async function parseActress() {
  return { mainName: 'Bob', profileSummary: 'Wrong person' }
}
module.exports = { parseActress }`
      }
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.pluginResult, { mainName: 'Bob', profileSummary: 'Wrong person' })
    assert.deepEqual(result.effectiveResult, { profileSummary: 'Wrong person' })
    assert.equal(result.error, undefined)
  })
})
