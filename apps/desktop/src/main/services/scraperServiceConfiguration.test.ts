import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ScraperServicePublicConfig } from '@shared/scraperServiceTypes'
import { ScraperServiceConfiguration } from './scraperServiceConfiguration'

const publicConfig: ScraperServicePublicConfig = {
  serverUrl: 'https://server.test',
  useScrapeProxy: false,
  hasToken: true,
  secretProtection: 'secure'
}

describe('ScraperServiceConfiguration', () => {
  it('keeps scraper service IPC policy behind one application boundary', async () => {
    const calls: string[] = []
    const service = new ScraperServiceConfiguration({
      get: () => {
        calls.push('get')
        return publicConfig
      },
      save: (_serviceId, input) => {
        calls.push(`save:${input.serverUrl}`)
        return publicConfig
      },
      test: async () => {
        calls.push('test')
        return {
          app: 'metatube',
          version: 'v1.4.0',
          dbVersion: '7',
          movieProviderCount: 2
        }
      },
      clear: () => {
        calls.push('clear')
      }
    })

    assert.equal(service.get('metatube'), publicConfig)
    assert.equal(service.save('metatube', {
      serverUrl: 'https://server.test',
      useScrapeProxy: false,
      tokenUpdate: { mode: 'keep' }
    }), publicConfig)
    assert.equal((await service.test('metatube', {
      serverUrl: 'https://server.test',
      useScrapeProxy: false,
      tokenUpdate: { mode: 'keep' }
    })).movieProviderCount, 2)
    assert.equal(service.clear('metatube'), true)
    assert.deepEqual(calls, ['get', 'save:https://server.test', 'test', 'clear'])
  })
})
