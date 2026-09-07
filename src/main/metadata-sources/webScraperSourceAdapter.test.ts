import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import type { BaseScraper } from '../scrapers/BaseScraper'
import {
  VideoMetadataSourceRegistry,
  WebScraperSourceAdapter,
  webScraperSourceId
} from './index'

const descriptor: ScraperPluginDescriptor = {
  kind: 'video',
  name: 'Contract Source',
  version: '1.2.3',
  description: 'Metadata source contract fixture',
  source: 'user',
  removable: true,
  exportable: true,
  supportedFields: ['title', 'cover', 'samples', 'actressesFemale', 'source']
}

describe('WebScraperSourceAdapter', () => {
  it('passes the stored code to legacy plugins unchanged while comparing normalized identities', async () => {
    let receivedCode = ''
    const scraper: BaseScraper = {
      scraperName: descriptor.name,
      async parseTask(code) {
        receivedCode = code
        return { code: 'TEST-001', title: 'Exact after normalization' }
      }
    }
    const source = new WebScraperSourceAdapter({ scraper, plugin: descriptor, proxyUrl: '' })

    const batch = await source.collect({
      target: { kind: 'code', code: ' test-001 ' },
      fields: ['title']
    })

    assert.equal(receivedCode, ' test-001 ')
    assert.equal(batch.candidates[0]?.result.title, 'Exact after normalization')
  })

  it('collects exact candidates with declared remote assets and source evidence', async () => {
    const calls: string[] = []
    const scraper: BaseScraper = {
      scraperName: descriptor.name,
      async parseTask(code, proxyUrl) {
        calls.push(`parse:${code}:${proxyUrl}`)
        return [
          { code: 'OTHER-001', title: 'Wrong', sourceUrl: 'https://wrong.example/item' },
          {
            code,
            title: 'First',
            summary: 'undeclared',
            coverUrl: 'https://image.example/cover.jpg',
            sampleImageUrls: ['https://image.example/sample.jpg'],
            actresses: [
              {
                name: 'Declared actress',
                gender: 'female',
                avatarUrl: 'https://image.example/avatar.jpg'
              }
            ],
            sourceUrl: 'HTTPS://EXAMPLE.COM:443/item#fragment'
          },
          { code, title: 'Duplicate', sourceUrl: 'https://example.com/item' },
          { code, title: 'Without URL' }
        ]
      }
    }
    const source = new WebScraperSourceAdapter({
      scraper,
      plugin: descriptor,
      proxyUrl: 'http://proxy.example:8080',
      runWithDelay: async (pluginName, task) => {
        calls.push(`delay:${pluginName}`)
        return task()
      }
    })

    const batch = await source.collect({
      target: { kind: 'code', code: 'TEST-001' },
      fields: ['title', 'cover', 'samples', 'actressesFemale', 'source']
    })

    assert.deepEqual(calls, [
      'delay:Contract Source',
      'parse:TEST-001:http://proxy.example:8080'
    ])
    assert.equal(source.descriptor.id, webScraperSourceId(descriptor.name))
    assert.deepEqual(
      batch.candidates.map((candidate) => candidate.result.title),
      ['First', 'Without URL']
    )
    assert.equal(batch.candidates[0].result.summary, undefined)
    assert.deepEqual(batch.candidates[0].assets, [
      {
        kind: 'remote-url',
        field: 'cover',
        position: 0,
        url: 'https://image.example/cover.jpg'
      },
      {
        kind: 'remote-url',
        field: 'samples',
        position: 0,
        url: 'https://image.example/sample.jpg'
      },
      {
        kind: 'remote-url',
        field: 'actressAvatar',
        position: 0,
        url: 'https://image.example/avatar.jpg'
      }
    ])
    assert.deepEqual(batch.candidates[0].evidence, {
      kind: 'web-scraper',
      sourceId: webScraperSourceId(descriptor.name),
      sourceName: descriptor.name,
      sourceUrl: 'https://example.com/item'
    })
    assert.equal(batch.warnings.length, 1)
    assert.match(batch.warnings[0], /OTHER-001/)
  })
})

describe('VideoMetadataSourceRegistry', () => {
  it('resolves stable source ids while preserving legacy plugin-name lookup', () => {
    const scraper: BaseScraper = {
      scraperName: descriptor.name,
      async parseTask() {
        return null
      }
    }
    const source = new WebScraperSourceAdapter({ scraper, plugin: descriptor, proxyUrl: '' })
    const registry = new VideoMetadataSourceRegistry([source])

    assert.equal(registry.require(source.descriptor.id), source)
    assert.equal(registry.requireLegacyPlugin(descriptor.name), source)
    assert.deepEqual(registry.list().map((item) => item.id), [source.descriptor.id])
  })
})
