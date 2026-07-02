import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { dryRunPluginPackage } from './pluginDevService'

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
    assert.deepEqual(result.result, { mainName: 'Alice', profileSummary: 'OK' })
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
      mainName: 'Alice',
      heightCm: 160,
      birthDate: '1995-01-01'
    })
  })
})
