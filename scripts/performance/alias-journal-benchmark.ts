import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { resetSettingsCacheForTests } from '../../apps/desktop/src/main/settings/settingsStore'
import { resetAssetKeyCacheForTests } from '@library/assetCrypto'
import { setPathAlias, getPathAlias, resetPathAliasCacheForTests } from '@library/assetPathAliases'
import { aliasStoreAbsAt, resolveMediaAssetsRoot } from '@library/assetStoragePaths'

it('measures encrypted journal growth for 1000 and 2000 aliases', (t) => {
  const previous = process.env.JAVDEX_TEST_USER_DATA
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-alias-bench-'))
  const results = []
  try {
    for (const count of [1000, 2000]) {
      process.env.JAVDEX_TEST_USER_DATA = path.join(root, String(count))
      resetSettingsCacheForTests()
      resetAssetKeyCacheForTests()
      resetPathAliasCacheForTests()
      const cipher = t.mock.method(crypto, 'createCipheriv')
      const started = performance.now()
      for (let index = 0; index < count; index++) setPathAlias(`covers/${index}.enc`, `covers/film-${index}.jpg`)
      const elapsedMs = performance.now() - started
      const encryptionCalls = cipher.mock.callCount()
      cipher.mock.restore()
      assert.equal(encryptionCalls, count)
      const journalBytes = fs.statSync(aliasStoreAbsAt(resolveMediaAssetsRoot())).size
      resetPathAliasCacheForTests()
      for (let index = 0; index < count; index++) assert.equal(getPathAlias(`covers/${index}.enc`), `covers/film-${index}.jpg`)
      results.push({ aliases: count, journalBytes, encryptionCalls, elapsedMs })
    }
    assert.ok(results[1].journalBytes / results[0].journalBytes < 2.1)
    const report = { measuredAt: new Date().toISOString(), runtime: process.versions, results,
      notes: ['Real temporary files with fsync, on macOS local storage; not Windows/HDD or p95.',
        'Journal file size and encryption invocation count, not total physical device writes.',
        'Below compaction threshold; cold full-file replay and total map memory remain unbounded by a fixed budget.'] }
    const json = JSON.stringify(report, null, 2) + '\n'
    if (process.env.JAVDEX_ALIAS_BENCH_OUTPUT) fs.writeFileSync(process.env.JAVDEX_ALIAS_BENCH_OUTPUT, json)
    else process.stdout.write(json)
  } finally {
    t.mock.restoreAll()
    resetPathAliasCacheForTests()
    resetAssetKeyCacheForTests()
    resetSettingsCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
