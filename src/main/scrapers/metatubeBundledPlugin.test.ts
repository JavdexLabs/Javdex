import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import type { ScrapeResult, VideoPluginScrapeResult } from '@shared/videoScrapeTypes'
import { resetSettingsCacheForTests, updateSettings } from '../settings/settingsStore'
import { setScraperServiceSecretCipherForTests } from '../settings/scraperServiceSecretStore'
import {
  setScraperServiceTransportForTests,
  type ScraperServiceTransport,
  type ScraperServiceTransportResponse
} from './configuredScraperService'
import { runUserVideoPlugin } from './scraperPluginSandbox'

let tempRoot: string | null = null
let previousUserData: string | undefined
let pluginCode = ''

function json(statusCode: number, value: unknown): ScraperServiceTransportResponse {
  return { statusCode, headers: {}, body: Buffer.from(JSON.stringify(value), 'utf8') }
}

function detail(provider: string, id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      provider,
      id,
      number: 'ABC-123',
      title: `${provider} title`,
      ...overrides
    }
  }
}

async function runMetaTube(
  transport: ScraperServiceTransport,
  code = ' abc-123 '
): Promise<VideoPluginScrapeResult> {
  setScraperServiceTransportForTests(transport)
  return runUserVideoPlugin('MetaTube', pluginCode, code, undefined, 'metatube')
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-metatube-plugin-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  setScraperServiceSecretCipherForTests({
    state: () => ({ protection: 'secure', backend: 'test' }),
    encrypt: (value) => Buffer.from(value, 'utf8'),
    decrypt: (value) => value.toString('utf8')
  })
  setScraperServiceTransportForTests(null)
  resetSettingsCacheForTests()
  updateSettings({
    scraperServiceConfigs: {
      metatube: { serverUrl: 'https://service.test/base', useScrapeProxy: false }
    }
  })
  pluginCode = fs.readFileSync(
    path.join(process.cwd(), 'src/main/bundled-plugins/video/MetaTube/index.cjs'),
    'utf8'
  )
})

afterEach(() => {
  setScraperServiceTransportForTests(null)
  setScraperServiceSecretCipherForTests(null)
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('MetaTube bundled video plugin', () => {
  it('keeps exact providers in search order and maps the documented fields', async () => {
    const requests: string[] = []
    const result = await runMetaTube(async (request) => {
      requests.push(request.url)
      const url = new URL(request.url)
      if (url.pathname.endsWith('/v1/movies/search')) {
        assert.equal(url.searchParams.get('q'), 'abc-123')
        assert.equal(url.searchParams.get('fallback'), 'true')
        return json(200, {
          data: [
            { provider: 'P/1', id: 'id/1', number: ' ABC-123 ' },
            { provider: 'Ignored', id: 'fuzzy', number: 'ABC-123-extra' },
            { provider: 'P/1', id: 'id/1', number: 'abc-123' },
            { provider: 'Second', id: 'two', number: 'abc-123' }
          ]
        })
      }
      const segments = url.pathname.split('/').map(decodeURIComponent)
      const provider = segments.at(-2)!
      const id = segments.at(-1)!
      assert.equal(url.searchParams.get('lazy'), 'true')
      if (provider === 'P/1') {
        return json(200, detail(provider, id, {
          title: '  First   title  ',
          summary: '  Summary   text ',
          maker: 'Maker',
          label: 'Approximate publisher',
          series: 'Series',
          director: 'Director',
          runtime: 123,
          score: 4.46,
          release_date: '2024-02-29',
          actors: [' Alice ', 'Alice', '', 'Bob'],
          genres: [' Drama ', 'Drama', 'Featured'],
          homepage: 'https://source.test/movie/ABC-123',
          preview_images: ['https://img.test/sample one.jpg?x=1&y=2']
        }))
      }
      return json(200, detail(provider, id, { actors: ['Carol'], score: 0 }))
    })

    assert.equal(Array.isArray(result), true)
    const candidates = result as ScrapeResult[]
    assert.equal(candidates.length, 2)
    assert.deepEqual(candidates[0], {
      code: 'ABC-123',
      title: 'First title',
      summary: 'Summary text',
      coverUrl: 'https://service.test/base/v1/images/primary/P%2F1/id%2F1?quality=90',
      releaseDate: '2024-02-29',
      maker: 'Maker',
      publisher: 'Approximate publisher',
      series: 'Series',
      director: 'Director',
      durationSeconds: 7380,
      actresses: [
        { name: 'Alice', gender: 'female' },
        { name: 'Bob', gender: 'female' }
      ],
      tags: ['Drama', 'Featured'],
      sourceUrl: 'https://source.test/movie/ABC-123',
      ratingAverage: 4.5,
      sampleImageUrls: [
        'https://service.test/base/v1/images/primary/P%2F1/id%2F1?url=https%3A%2F%2Fimg.test%2Fsample%2520one.jpg%3Fx%3D1%26y%3D2&ratio=0&pos=0&auto=false&quality=90'
      ]
    })
    assert.equal(candidates[1]?.title, 'Second title')
    assert.equal(candidates[1]?.ratingAverage, undefined)
    assert.deepEqual(candidates[1]?.actresses, [{ name: 'Carol', gender: 'female' }])
    assert.equal(requests.length, 3)
  })

  it('returns no candidates for search 404 or fuzzy-only search results', async () => {
    assert.deepEqual(await runMetaTube(async () => json(404, { error: { message: 'none' } })), [])
    assert.deepEqual(await runMetaTube(async () => json(200, {
      data: [
        { provider: 'Prefix', id: '1', number: 'prefix-ABC-123-suffix' },
        { provider: 'No separator', id: '2', number: 'ABC123' },
        { provider: 'Underscore', id: '3', number: 'ABC_123' },
        { provider: 'Internal space', id: '4', number: 'ABC 123' },
        { provider: 'Full width', id: '5', number: 'ＡＢＣ-１２３' }
      ]
    })), [])
  })

  it('rejects a detail whose exact code differs from its search item', async () => {
    await assert.rejects(
      () => runMetaTube(async (request) => {
        const url = new URL(request.url)
        return url.pathname.endsWith('/search')
          ? json(200, { data: [{ provider: 'Changed', id: '1', number: 'ABC-123' }] })
          : json(200, detail('Changed', '1', { number: 'ABC123' }))
      }),
      /详情番号与查询番号不一致/
    )
  })

  it('rejects too many exact providers before requesting details', async () => {
    let detailRequests = 0
    await assert.rejects(
      () => runMetaTube(async (request) => {
        const url = new URL(request.url)
        if (url.pathname.endsWith('/search')) {
          return json(200, {
            data: Array.from({ length: 9 }, (_, index) => ({
              provider: `Provider-${index}`,
              id: String(index),
              number: 'ABC-123'
            }))
          })
        }
        detailRequests += 1
        return json(200, {})
      }),
      /超过 8 个精确候选/
    )
    assert.equal(detailRequests, 0)
  })

  it('fails the entire scrape if one exact detail request fails', async () => {
    await assert.rejects(
      () => runMetaTube(async (request) => {
        const url = new URL(request.url)
        if (url.pathname.endsWith('/search')) {
          return json(200, {
            data: [
              { provider: 'Good', id: '1', number: 'ABC-123' },
              { provider: 'Broken', id: '2', number: 'ABC-123' }
            ]
          })
        }
        return url.pathname.includes('/Broken/')
          ? json(503, { error: { message: 'offline' } })
          : json(200, detail('Good', '1'))
      }),
      /暂时不可用/
    )
  })

  it('caps public sample proxy URLs at forty without putting credentials in them', async () => {
    const result = await runMetaTube(async (request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/search')) {
        return json(200, { data: [{ provider: 'Samples', id: '1', number: 'ABC-123' }] })
      }
      return json(200, detail('Samples', '1', {
        preview_images: Array.from(
          { length: 41 },
          (_, index) => `https://images.test/${index}.jpg`
        )
      }))
    })
    const candidate = Array.isArray(result) ? result[0] : result
    assert.equal(candidate?.sampleImageUrls?.length, 40)
    assert.equal(
      candidate?.sampleImageUrls?.every((url) =>
        url.startsWith('https://service.test/base/v1/images/primary/Samples/1?') &&
        !url.toLowerCase().includes('token')
      ),
      true
    )
  })

  it('rejects incompatible known fields and caps detail concurrency at four', async () => {
    let active = 0
    let maxActive = 0
    const candidates = await runMetaTube(async (request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/search')) {
        return json(200, {
          data: Array.from({ length: 8 }, (_, index) => ({
            provider: `Provider-${index}`,
            id: String(index),
            number: 'ABC-123'
          }))
        })
      }
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      const segments = url.pathname.split('/').map(decodeURIComponent)
      return json(200, detail(segments.at(-2)!, segments.at(-1)!))
    })
    assert.equal((candidates as ScrapeResult[]).length, 8)
    assert.equal(maxActive, 4)

    await assert.rejects(
      () => runMetaTube(async (request) => {
        const url = new URL(request.url)
        return url.pathname.endsWith('/search')
          ? json(200, { data: [{ provider: 'Bad', id: '1', number: 'ABC-123' }] })
          : json(200, detail('Bad', '1', { actors: [{ name: 'not supported' }] }))
      }),
      /actors 类型不兼容/
    )
  })
})
