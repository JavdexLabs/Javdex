import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  configureLibraryHost,
  resetLibraryHostForTests,
  resolveLibraryUserDataPath
} from './host'

describe('library host', () => {
  const previous = process.env.JAVDEX_TEST_USER_DATA
  afterEach(() => {
    resetLibraryHostForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
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

  it('rejects production reads before the host is configured', () => {
    delete process.env.JAVDEX_TEST_USER_DATA
    resetLibraryHostForTests()
    assert.throws(() => resolveLibraryUserDataPath(), /Library host is not configured/)
  })
})
