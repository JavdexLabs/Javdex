import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ScrapeResult } from '@shared/videoScrapeTypes'
import {
  runUserVideoPlugin,
  setSandboxPageFetcherForTests
} from './scraperPluginSandbox'

const JAVDB_PLUGIN_PATH = path.join(
  process.cwd(),
  'apps/desktop/src/main/bundled-plugins/video/JavDB/index.cjs'
)
const JAVLIBRARY_PLUGIN_PATH = path.join(
  process.cwd(),
  'apps/desktop/src/main/bundled-plugins/video/JavLibrary/index.cjs'
)

let tempRoot: string | null = null
let previousUserData: string | undefined

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-bundled-video-candidates-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
})

afterEach(() => {
  setSandboxPageFetcherForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  previousUserData = undefined
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

function html(value: string): string {
  return value
}

function asCandidates(value: ScrapeResult | ScrapeResult[] | null): ScrapeResult[] {
  assert.ok(Array.isArray(value))
  return value
}

describe('bundled video candidate plugins', () => {
  it('normalizes year-month values through the documented sandbox helper', async () => {
    const result = await runUserVideoPlugin(
      'sandbox date helper fixture',
      `module.exports = { async parseVideo(ctx) {
        return {
          code: ctx.code,
          title: [
            ctx.helpers.normalizeDate('2026-05'),
            ctx.helpers.normalizeDate('2026年05月'),
            ctx.helpers.normalizeDate('2026-05-06')
          ].join('|')
        };
      } };`,
      'ABC-123'
    )

    assert.ok(result && !Array.isArray(result))
    assert.equal(result.title, '2026-05-01|2026-05-01|2026-05-06')
  })

  it('JavDB fetches every first-page exact match and never falls back to a fuzzy item', async () => {
    const requested: string[] = []
    setSandboxPageFetcherForTests(async (url) => {
      requested.push(url)
      if (url.includes('/search?')) {
        return html(`
          <div class="movie-list">
            <div class="item"><a class="box" href="/v/exact-a"></a><div class="video-title"><strong>ABC-123</strong></div></div>
            <div class="item"><a class="box" href="/v/fuzzy"></a><div class="video-title"><strong>ABC-1234</strong></div></div>
            <div class="item"><a class="box" href="/v/exact-b"></a><div class="video-title"><strong> abc-123 </strong></div></div>
          </div>
        `)
      }
      if (url.endsWith('/v/exact-a')) return javdbDetail('ABC-123', 'Candidate A')
      if (url.endsWith('/v/exact-b')) return javdbDetail('ABC-123', 'Candidate B')
      throw new Error(`unexpected request: ${url}`)
    })

    const candidates = asCandidates(
      await runUserVideoPlugin(
        'JavDB candidate fixture',
        fs.readFileSync(JAVDB_PLUGIN_PATH, 'utf-8'),
        'ABC-123'
      )
    )

    assert.deepEqual(
      candidates.map((candidate) => ({
        code: candidate.code,
        title: candidate.title,
        sourceUrl: candidate.sourceUrl
      })),
      [
        { code: 'ABC-123', title: 'Candidate A', sourceUrl: 'https://javdb.com/v/exact-a' },
        { code: 'ABC-123', title: 'Candidate B', sourceUrl: 'https://javdb.com/v/exact-b' }
      ]
    )
    assert.equal(requested.some((url) => url.endsWith('/v/fuzzy')), false)
  })

  it('JavDB fails the complete scrape when any exact-match detail fails', async () => {
    setSandboxPageFetcherForTests(async (url) => {
      if (url.includes('/search?')) {
        return html(`
          <div class="movie-list">
            <div class="item"><a class="box" href="/v/ok"></a><div class="video-title"><strong>ABC-123</strong></div></div>
            <div class="item"><a class="box" href="/v/fail"></a><div class="video-title"><strong>ABC-123</strong></div></div>
          </div>
        `)
      }
      if (url.endsWith('/v/ok')) return javdbDetail('ABC-123', 'Complete')
      throw new Error('forced detail failure')
    })

    await assert.rejects(
      () =>
        runUserVideoPlugin(
          'JavDB detail failure fixture',
          fs.readFileSync(JAVDB_PLUGIN_PATH, 'utf-8'),
          'ABC-123'
        ),
      /forced detail failure/
    )
  })

  it('JavLibrary returns all exact cards and ignores title containment or first-item fallback', async () => {
    const requested: string[] = []
    setSandboxPageFetcherForTests(async (url) => {
      requested.push(url)
      if (url.includes('vl_searchbyid.php')) {
        return html(`
          <div class="videos">
            <div class="video"><a href="./?v=one"><span class="id">ABC-123</span></a></div>
            <div class="video"><a href="./?v=fuzzy" title="ABC-123 title"><span class="id">ABC-1234</span></a></div>
            <div class="video"><a href="./?v=two"><span class="id"> abc-123 </span></a></div>
          </div>
        `)
      }
      if (url.endsWith('/?v=one')) return javlibraryDetail('ABC-123', 'Library A')
      if (url.endsWith('/?v=two')) return javlibraryDetail('ABC-123', 'Library B')
      throw new Error(`unexpected request: ${url}`)
    })

    const candidates = asCandidates(
      await runUserVideoPlugin(
        'JavLibrary candidate fixture',
        fs.readFileSync(JAVLIBRARY_PLUGIN_PATH, 'utf-8'),
        'ABC-123'
      )
    )

    assert.deepEqual(
      candidates.map((candidate) => ({
        code: candidate.code,
        title: candidate.title,
        sourceUrl: candidate.sourceUrl
      })),
      [
        {
          code: 'ABC-123',
          title: 'Library A',
          sourceUrl: 'https://www.javlibrary.com/cn/?v=one'
        },
        {
          code: 'ABC-123',
          title: 'Library B',
          sourceUrl: 'https://www.javlibrary.com/cn/?v=two'
        }
      ]
    )
    assert.equal(requested.some((url) => url.includes('v=fuzzy')), false)
  })
})

function javdbDetail(code: string, title: string): string {
  return `
    <div class="video-detail">
      <h2 class="title"><span class="current-title">${title}</span></h2>
      <div class="panel-block"><strong>番號:</strong><span class="value">${code}</span></div>
      <div class="panel-block"><strong>日期:</strong><span class="value">2026-05-06</span></div>
    </div>
  `
}

function javlibraryDetail(code: string, title: string): string {
  return `
    <div id="video_info"></div>
    <div id="video_id"><span class="text">${code}</span></div>
    <div id="video_title"><a><span class="post-title text">${code} ${title}</span></a></div>
    <div id="video_date"><span class="text">2026-05-06</span></div>
  `
}
