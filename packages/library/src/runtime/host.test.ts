import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { configureDesktopLibraryTestRuntime } from '../../../../apps/desktop/src/main/libraryRuntime'
import {
  configureAgentWorkTablePrefix,
  configureLibraryHost,
  qualifyAgentSql,
  resetLibraryHostForTests,
  resolveLibraryAssetEncryption,
  resolveLibraryMediaAssetsPath,
  resolveLibraryScrapeProxyUrl,
  resolveLibraryUserDataPath
} from './host'

describe('library host', () => {
  const previous = process.env.JAVDEX_TEST_USER_DATA
  afterEach(() => {
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    configureAgentWorkTablePrefix('')
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

  it('reads the scrape proxy URL from the host without touching desktop settings', () => {
    delete process.env.JAVDEX_TEST_USER_DATA
    configureLibraryHost({
      userDataPath: () => '/var/lib/javdex',
      http: {
        scrapeProxyUrl: () => 'socks5://127.0.0.1:1080'
      }
    })
    assert.equal(resolveLibraryScrapeProxyUrl(), 'socks5://127.0.0.1:1080')
  })

  it('treats a missing scrape proxy as empty instead of reading settings', () => {
    delete process.env.JAVDEX_TEST_USER_DATA
    configureLibraryHost({ userDataPath: () => '/var/lib/javdex' })
    assert.equal(resolveLibraryScrapeProxyUrl(), '')
  })

  it('rejects production reads before the host is configured', () => {
    delete process.env.JAVDEX_TEST_USER_DATA
    resetLibraryHostForTests()
    assert.throws(() => resolveLibraryUserDataPath(), /Library host is not configured/)
  })

  it('qualifies agent tables for an attached workStore without rewriting restore temp tables', () => {
    assert.equal(
      qualifyAgentSql('SELECT id FROM agent_runs WHERE status <> \'closed\''),
      'SELECT id FROM agent_runs WHERE status <> \'closed\''
    )
    configureAgentWorkTablePrefix('work.')
    assert.equal(
      qualifyAgentSql(
        'SELECT id FROM agent_runs WHERE EXISTS (SELECT 1 FROM agent_resource_cleanup AS cleanup WHERE cleanup.run_id = agent_runs.id)'
      ),
      'SELECT id FROM work.agent_runs WHERE EXISTS (SELECT 1 FROM work.agent_resource_cleanup AS cleanup WHERE cleanup.run_id = work.agent_runs.id)'
    )
    assert.equal(
      qualifyAgentSql('INSERT INTO agent_restore_deadbeef (id) SELECT id FROM agent_runs'),
      'INSERT INTO agent_restore_deadbeef (id) SELECT id FROM work.agent_runs'
    )
    assert.equal(
      qualifyAgentSql('SELECT * FROM work.agent_runs'),
      'SELECT * FROM work.agent_runs'
    )
  })
})
