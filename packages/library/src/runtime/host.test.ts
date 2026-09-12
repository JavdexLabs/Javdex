import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { configureDesktopLibraryTestRuntime } from '../../../../apps/desktop/src/main/libraryRuntime'
import {
  configureLibraryHost,
  resetLibraryHostForTests,
  resolveLibraryAssetEncryption,
  resolveLibraryMediaAssetsPath,
  resolveLibraryUserDataPath
} from './host'

describe('library host', () => {
  const previous = process.env.JAVDEX_TEST_USER_DATA
  afterEach(() => {
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    configureDesktopLibraryTestRuntime()
  })

  it('prefers the test userData override over a configured host', () => {
    process.env.JAVDEX_TEST_USER_DATA = '/tmp/javdex-host-test'
    configureLibraryHost({ userDataPath: () => '/should-not-use' })
    assert.equal(resolveLibraryUserDataPath(), '/tmp/javdex-host-test')
  })

  it('uses the configured host when no test override is set', () => {
    delete process.env.JAVDEX_TEST_USER_DATA
    configureLibraryHost({ userDataPath: () => '/var/lib/javdex' })
    assert.equal(resolveLibraryUserDataPath(), '/var/lib/javdex')
  })

  it('reads asset encryption and custom media path from the host', () => {
    delete process.env.JAVDEX_TEST_USER_DATA
    configureLibraryHost({
      userDataPath: () => '/var/lib/javdex',
      assets: {
        assetEncryption: () => true,
        mediaAssetsPath: () => '/mnt/assets'
      }
    })
    assert.equal(resolveLibraryAssetEncryption(), true)
    assert.equal(resolveLibraryMediaAssetsPath(), '/mnt/assets')
  })

  it('rejects production reads before the host is configured', () => {
    delete process.env.JAVDEX_TEST_USER_DATA
    resetLibraryHostForTests()
    assert.throws(() => resolveLibraryUserDataPath(), /Library host is not configured/)
  })
})
