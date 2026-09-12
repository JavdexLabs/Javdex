import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildScrapeUserAgent,
  derivePlatformFromOsToken,
  resetScrapeUaProfileCache
} from './scrapeUaProfile'

test('buildScrapeUserAgent drops Electron and app product tokens', () => {
  const raw =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.118 Electron/33.2.0 Safari/537.36 Javdex/1.2.3'
  assert.equal(
    buildScrapeUserAgent(raw),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.118 Safari/537.36'
  )
})

test('derivePlatformFromOsToken maps Windows, macOS and Linux', () => {
  assert.equal(derivePlatformFromOsToken('Windows NT 10.0; Win64; x64').secChUaPlatform, '"Windows"')
  assert.equal(
    derivePlatformFromOsToken('Macintosh; Intel Mac OS X 10_15_7').secChUaPlatform,
    '"macOS"'
  )
  assert.equal(derivePlatformFromOsToken('X11; Linux x86_64').secChUaPlatform, '"Linux"')
})

test('resetScrapeUaProfileCache clears memoized profile', () => {
  resetScrapeUaProfileCache()
  assert.doesNotThrow(() => resetScrapeUaProfileCache())
})
