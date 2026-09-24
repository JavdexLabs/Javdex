import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { CatalogBackend, MutationContext } from '../application/catalogBackend'
import { structuredError } from '@shared/protocol/errors'
import { installScraperPluginPackage } from '../scrapers/scraperPluginService'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { createScrapeCatalogBinding } from './scrapeCatalogBinding'

let tempRoot: string
let previousUserData: string | undefined

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-remote-workflow-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  resetSettingsCacheForTests()
})

afterEach(() => {
  mock.restoreAll()
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

async function installVideo(results: unknown) {
  await installScraperPluginPackage({
    schemaVersion: 1, kind: 'video', name: 'Remote Workflow Video', version: '1.0.0',
    description: 'Offline workflow fixture', supportedFields: ['title', 'cover', 'source'],
    code: `module.exports = { async parseVideo() { return ${JSON.stringify(results)} } }`
  })
}

describe('remote persistence adapters through the shared scrape binding', () => {
  it('uses authoritative effective fields and preserves captured video and pending revisions', async () => {
    await installVideo({ code: 'ABC-123', title: 'New title', sourceUrl: 'https://example.test/one' })
    const calls: string[] = []
    const backend = {
      mode: 'remote',
      queries: {
        getVideo: async () => ({ id: 7, code: 'ABC-123', generation: 2, revision: 5 }),
        resolveScrapeFields: async (input: { fields: string[]; sourceName: string }) => {
          calls.push('fields')
          assert.deepEqual(input.fields, ['title', 'source'])
          assert.equal(input.sourceName, 'Remote Workflow Video')
          return { fields: ['title'] }
        }
      },
      pendingVideoScrapes: {
        page: async () => { calls.push('pending'); return { items: [{ id: 8, videoId: 7, revision: 6 }] } }
      },
      videos: {
        applyScrapeCandidate: async (
          input: Parameters<CatalogBackend['videos']['applyScrapeCandidate']>[0], ctx: MutationContext
        ) => {
          calls.push('apply')
          assert.deepEqual(input.fields, ['title'])
          assert.ok(input.candidate && typeof input.candidate === 'object' && 'title' in input.candidate)
          assert.equal(input.candidate.title, 'New title')
          assert.equal(input.sourceName, 'Remote Workflow Video')
          assert.equal(input.ratingSourceName, 'Remote Workflow Video')
          assert.deepEqual(ctx.expectedVersions, {
            V: { generation: 3, revision: 4 }, Q: { generation: 1, revision: 6 }
          })
          return { applied: true, warnings: ['catalog warning'] }
        }
      }
    } as unknown as CatalogBackend
    const outcome = await createScrapeCatalogBinding(backend).scrapeVideo(7, 'Remote Workflow Video', {
      fields: ['title', 'source'], mode: 'fillEmpty', closeBrowser: false,
      expectedVersion: { generation: 3, revision: 4 }
    })
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.warnings, ['catalog warning'])
    assert.deepEqual(calls, ['fields', 'pending', 'apply'])
    assert.equal(fs.existsSync(path.join(tempRoot, 'library.db')), false)
  })

  for (const ambiguous of [true, false]) {
    it(`retains unselected pending images for ${ambiguous ? 'multiple candidates' : 'a business identity conflict'}`, async () => {
      const candidates = [
        { code: 'ABC-123', title: 'One', coverUrl: 'https://example.test/one.png', sourceUrl: 'https://example.test/one' },
        { code: 'ABC-123', title: 'Two', coverUrl: 'https://example.test/two.png', sourceUrl: 'https://example.test/two' }
      ]
      await installVideo(ambiguous ? candidates : candidates[0])
      const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer()
      const fetches: string[] = []
      mock.method(scrapeBrowser, 'fetchBuffer', async (url: string) => { fetches.push(url); return image })
      let uploads = 0
      let puts = 0
      let applies = 0
      let replacements = 0
      const backend = {
        mode: 'remote', queries: { getVideo: async () => ({ id: 7, code: 'ABC-123', generation: 2, revision: 5 }) },
        assets: {
          createUpload: async (input: { purpose: string }) => {
            assert.equal(input.purpose, 'pendingScrapeStaging')
            return { uploadId: `upload-${++uploads}` }
          },
          putUpload: async (input: { body: Buffer }) => { assert.equal(input.body, image); puts++ }
        },
        videos: {
          applyScrapeCandidate: async () => {
            applies++
            throw structuredError('IDENTITY_CONFLICT', 'Business identity already owned')
          }
        },
        pendingVideoScrapes: {
          page: async () => ({ items: [] }),
          replace: async (
            input: Parameters<CatalogBackend['pendingVideoScrapes']['replace']>[0], ctx: MutationContext
          ) => {
            replacements++
            assert.deepEqual(input.selectedFields, ['title'])
            assert.deepEqual(input.applicableFields, ['title'])
            assert.deepEqual(ctx.expectedVersions, { V: { generation: 2, revision: 5 } })
            const saved = input.sources[0].candidates
            assert.equal(saved.length, ambiguous ? 2 : 1)
            assert.deepEqual(saved.map((entry) => entry.cover),
              Array.from({ length: saved.length }, (_, i) => ({ kind: 'upload', uploadId: `upload-${i + 1}` })))
            return { pendingScrapeId: 19 }
          }
        }
      } as unknown as CatalogBackend
      const outcome = await createScrapeCatalogBinding(backend).scrapeVideo(7, 'Remote Workflow Video', {
        fields: ['title'], closeBrowser: false
      })
      assert.equal(outcome.pending, true)
      assert.equal(outcome.pendingScrapeId, 19)
      assert.equal(applies, ambiguous ? 0 : 1)
      assert.equal(replacements, 1)
      assert.equal(uploads, ambiguous ? 2 : 1)
      assert.equal(puts, uploads)
      assert.deepEqual(fetches, candidates.slice(0, uploads).map((entry) => entry.coverUrl))
      assert.equal(fs.existsSync(path.join(tempRoot, 'library.db')), false)
    })
  }

  it('preserves actress query options, effective fields and captured revision without a local catalog', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1, kind: 'actress', name: 'Remote Workflow Actress', version: '1.0.0',
      description: 'Offline profile fixture', supportedFields: ['profileSummary', 'avatar'],
      code: `module.exports = { async parseActress(ctx) {
        return { profileSummary: [ctx.mainName, ...ctx.aliases].join('|') }
      } }`
    })
    let applied = false
    const backend = {
      mode: 'remote',
      queries: { resolveScrapeFields: async () => ({ fields: ['profileSummary'] }) },
      actresses: {
        get: async () => ({ main_name: 'Main', aliases: ['Alias'], name_zh: '中文', name_en: 'English' }),
        applyScrapeCandidate: async (
          input: Parameters<CatalogBackend['actresses']['applyScrapeCandidate']>[0], ctx: MutationContext
        ) => {
          applied = true
          assert.ok(input.candidate && typeof input.candidate === 'object' && 'profileSummary' in input.candidate)
          assert.equal(input.candidate.profileSummary, 'Query|Main|Alias|中文|English')
          assert.deepEqual(input.fields, ['profileSummary'])
          assert.deepEqual(ctx.expectedVersions, { A: { generation: 4, revision: 9 } })
          return { applied: true }
        }
      }
    } as unknown as CatalogBackend
    const outcome = await createScrapeCatalogBinding(backend).scrapeActress(7, 'Remote Workflow Actress', {
      fields: ['profileSummary', 'avatar'], mode: 'fillEmpty', queryName: 'Query', useAliases: true,
      closeBrowser: false, expectedVersion: { generation: 4, revision: 9 }
    })
    assert.equal(applied, true)
    assert.equal(outcome.status, 'success')
    assert.equal(fs.existsSync(path.join(tempRoot, 'library.db')), false)
  })
})
