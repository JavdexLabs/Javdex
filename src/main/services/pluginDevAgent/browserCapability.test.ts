import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PluginBrowserCapabilityModule,
  browserCapabilityResultLimitBytes,
  readBrowserArtifactBundle
} from './browserCapability'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('PluginBrowserCapabilityModule', () => {
  it('uses action-specific result budgets', () => {
    assert.equal(browserCapabilityResultLimitBytes('status'), 3_000)
    assert.equal(browserCapabilityResultLimitBytes('find'), 12_000)
    assert.equal(browserCapabilityResultLimitBytes('evaluate'), 16_000)
    assert.equal(browserCapabilityResultLimitBytes('html'), 20_000)
    assert.equal(browserCapabilityResultLimitBytes('open'), 64_000)
    assert.equal(browserCapabilityResultLimitBytes('click'), 64_000)
    assert.equal(browserCapabilityResultLimitBytes('scroll'), 64_000)
    assert.equal(browserCapabilityResultLimitBytes('snapshot'), 64_000)
  })

  it('inlines complete small page-fact sections instead of keeping an oversized snapshot', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const snapshot = `${'- link "广告" [ref=ad]\n'.repeat(120)}`
    const fullSnapshot = [
      `${'- link "广告和推荐内容" [ref=ad]\n'.repeat(800)}`,
      '- heading "MILK-181 detail" [ref=e1]',
      '- text: 發行日期: 2023-08-03',
      '- link "倉本すみれ" [ref=e2]: /actresses/sumire',
      '- text: 類型: 制服, 戀愛',
      ...Array.from(
        { length: 13 },
        (_, index) => `- link "样张 ${index + 1}" [ref=sample-${index + 1}]: /samples/${index + 1}.jpg`
      )
    ].join('\n')
    const pageFacts = {
      headings: ['MILK-181 detail'],
      metadata: { 'og:image': 'https://img.example.test/milk-181.jpg' },
      labeledRows: [
        { label: '發行日期', value: '2023-08-03', links: [] },
        { label: '女優', value: '倉本すみれ', links: [{ text: '倉本すみれ', href: '/actresses/sumire' }] }
      ],
      links: Array.from({ length: 500 }, (_, index) => ({
        text: `页面链接 ${index + 1}`,
        href: `/links/${index + 1}`
      }))
    }
    const first = await module.execute({
      sessionId: 'session-full',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/MILK-181' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/MILK-181',
            title: 'MILK-181 detail',
            snapshot,
            snapshotExcerpted: true,
            evidenceIncomplete: false,
            fullSnapshotTruncated: false,
            pageFacts
          },
          fullSnapshot
        }
      })
    })
    const second = await module.execute({
      sessionId: 'session-full',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/MILK-181' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/MILK-181',
            title: 'MILK-181 detail',
            snapshot,
            snapshotExcerpted: true,
            evidenceIncomplete: false,
            fullSnapshotTruncated: false,
            pageFacts
          },
          fullSnapshot
        }
      })
    })
    assert.ok(Buffer.byteLength(first.content, 'utf8') > 3_000)
    assert.ok(
      Buffer.byteLength(first.content, 'utf8') <= browserCapabilityResultLimitBytes('open')
    )
    const compact = JSON.parse(first.content) as Record<string, unknown>
    assert.equal(compact.action, 'open')
    assert.equal(compact.url, 'https://example.test/MILK-181')
    assert.equal(compact.title, 'MILK-181 detail')
    const packedFacts = compact.pageFacts as {
      labeledRows?: typeof pageFacts.labeledRows
      links?: typeof pageFacts.links
      headings?: string[]
      metadata?: Record<string, string>
    } | undefined
    assert.equal(compact.observationMode, 'artifact')
    assert.equal(compact.inlineComplete, false)
    assert.equal(compact.artifactComplete, true)
    assert.equal(compact.snapshotExcerpted, undefined)
    assert.equal(compact.evidenceIncomplete, false)
    assert.equal(compact.truncated, undefined)
    assert.equal(compact.compactResult, undefined)
    assert.ok((compact.omittedInlineSections as string[]).includes('snapshot'))
    assert.equal(compact.snapshot, undefined)
    assert.deepEqual(packedFacts?.labeledRows, pageFacts.labeledRows)
    assert.deepEqual(packedFacts?.headings, pageFacts.headings)
    assert.deepEqual(packedFacts?.metadata, pageFacts.metadata)
    if (packedFacts?.links) {
      assert.equal(packedFacts.links.length, 500)
      assert.equal(packedFacts.links.at(-1)?.text, '页面链接 500')
    } else {
      assert.deepEqual(
        (compact.pageFactsSummary as Array<Record<string, unknown>>)
          .find((item) => item.section === 'links'),
        {
          section: 'links',
          byteLength: Buffer.byteLength(JSON.stringify(pageFacts.links), 'utf8'),
          itemCount: 500
        }
      )
    }
    assert.deepEqual(compact.nextActions, ['find', 'html', 'read-section'])
    assert.equal(first.structured?.artifactRef, second.structured?.artifactRef)
    const unchanged = JSON.parse(second.content) as Record<string, unknown>
    assert.equal(unchanged.observationMode, 'unchanged')
    assert.ok(Buffer.byteLength(second.content, 'utf8') <= 3_000)
    const artifact = readBrowserArtifactBundle(
      directory,
      String(first.structured?.artifactRef)
    )
    assert.equal(artifact.content, undefined)
    assert.equal(artifact.structured, undefined)
    const artifactObservation = artifact.observation as Record<string, unknown>
    assert.equal(artifactObservation.snapshot, fullSnapshot)
    assert.deepEqual(artifactObservation.pageFacts, pageFacts)
    assert.equal(artifactObservation.fullSnapshot, undefined)
    assert.match(first.content, /artifactRef/)
  })

  it('omits an oversized page-fact section as a whole and never returns a prefix', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-omit-section-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const labeledRows = [
      { label: '發行日期', value: '2023-08-03', links: [] },
      { label: '番號', value: 'MILK-181', links: [] }
    ]
    const links = Array.from({ length: 2_000 }, (_, index) => ({
      text: `页面链接 ${index + 1}`,
      href: `/links/${index + 1}`
    }))
    const result = await module.execute({
      sessionId: 'session-omit-links',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/MILK-181' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/MILK-181',
            title: 'MILK-181 detail',
            snapshot: '- heading "MILK-181 detail" [ref=e1]',
            pageFacts: { labeledRows, links }
          },
          fullSnapshot: '- heading "MILK-181 detail" [ref=e1]'
        }
      })
    })
    const compact = JSON.parse(result.content) as Record<string, unknown>
    const packedFacts = compact.pageFacts as {
      labeledRows?: typeof labeledRows
      links?: typeof links
    } | undefined

    assert.ok(Buffer.byteLength(result.content, 'utf8') <= browserCapabilityResultLimitBytes('open'))
    assert.equal(compact.inlineComplete, false)
    assert.deepEqual(packedFacts?.labeledRows, labeledRows)
    assert.equal(packedFacts?.links, undefined)
    assert.ok((compact.omittedInlineSections as string[]).includes('links'))
    assert.doesNotMatch(result.content, /页面链接 1/)
    assert.doesNotMatch(result.content, /页面链接 2000/)
    const linksSummary = (compact.pageFactsSummary as Array<Record<string, unknown>>)
      .find((item) => item.section === 'links')
    assert.equal(linksSummary?.section, 'links')
    assert.equal(linksSummary?.itemCount, 2_000)
    assert.ok(Number(linksSummary?.byteLength) > 0)
    assert.deepEqual(compact.nextActions, ['find', 'html', 'read-section'])
  })

  it('returns an omitted artifact section through bounded cursor pages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-section-pages-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const links = Array.from({ length: 2_000 }, (_, index) => ({
      text: `页面链接 ${index + 1}`,
      href: `https://example.test/links/${index + 1}`
    }))
    const observation = await module.execute({
      sessionId: 'session-section-pages',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/detail' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/detail',
            snapshot: '- heading "detail" [ref=e1]',
            pageFacts: { links }
          },
          fullSnapshot: '- heading "detail" [ref=e1]'
        }
      })
    })
    const artifactRef = String(observation.structured?.artifactRef)
    const received: Array<{ text: string; href: string }> = []
    let cursor: string | undefined
    let pages = 0
    do {
      const result = module.readSection({
        workspaceDirectory: directory,
        artifactRef,
        section: 'links',
        ...(cursor ? { cursor } : {})
      })
      const page = JSON.parse(result.content) as {
        entries: Array<{ value: { text: string; href: string } }>
        complete: boolean
        nextCursor?: string
      }
      assert.equal(result.ok, true)
      assert.ok(Buffer.byteLength(result.content, 'utf8') <= 20_000)
      assert.doesNotMatch(result.content, /\$artifactTextRef|\.part-/)
      received.push(...page.entries.map((entry) => entry.value))
      cursor = page.nextCursor
      pages += 1
      assert.ok(pages < 30)
    } while (cursor)

    assert.deepEqual(received, links)
    assert.ok(pages > 1)
  })

  it('rejects read-section paths outside the browser artifact directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-section-path-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()

    const result = module.readSection({
      workspaceDirectory: directory,
      artifactRef: 'plugin.json',
      section: 'snapshot'
    })

    assert.equal(result.ok, false)
    assert.equal(result.structured?.code, 'BROWSER_ARTIFACT_PATH_INVALID')
  })

  it('keeps a small localeLinks section when snapshot and content links are omitted', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-locale-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const localeLinks = [
      { text: '简体中文', href: 'https://example.test/cn', rawHref: '/cn' },
      { text: '繁體中文', href: 'https://example.test/', rawHref: '/' }
    ]
    const links = Array.from({ length: 2_000 }, (_, index) => ({
      text: `页面链接 ${index + 1}`,
      href: `/links/${index + 1}`
    }))
    const snapshot = `${'- link "广告和推荐内容" [ref=ad]\n'.repeat(800)}`
    const result = await module.execute({
      sessionId: 'session-locale-links',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/',
            title: 'Home',
            snapshot,
            pageFacts: { links, localeLinks }
          },
          fullSnapshot: snapshot
        }
      })
    })
    const compact = JSON.parse(result.content) as Record<string, unknown>
    const packedFacts = compact.pageFacts as {
      links?: typeof links
      localeLinks?: typeof localeLinks
    } | undefined

    assert.ok(Buffer.byteLength(result.content, 'utf8') <= browserCapabilityResultLimitBytes('open'))
    assert.equal(compact.inlineComplete, false)
    assert.ok((compact.omittedInlineSections as string[]).includes('links'))
    assert.equal(packedFacts?.links, undefined)
    assert.deepEqual(packedFacts?.localeLinks, localeLinks)
  })

  it('hides oversized artifact string segments behind read-section pagination', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-readable-artifact-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const fullSnapshot = `- main:\n  - text: ${'single-line-page-fact '.repeat(4_000)}`
    const result = await module.execute({
      sessionId: 'session-readable-artifact',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/detail' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/detail',
            snapshot: fullSnapshot,
            pageFacts: { headings: ['detail'] }
          },
          fullSnapshot
        }
      })
    })
    const artifactPath = path.join(directory, String(result.structured?.artifactRef))
    const artifactDirectory = path.dirname(artifactPath)
    const artifactPrefix = path.basename(artifactPath, '.json')
    const files = fs.readdirSync(artifactDirectory)
      .filter((name) => name === `${artifactPrefix}.json` || name.startsWith(`${artifactPrefix}.part-`))
      .map((name) => path.join(artifactDirectory, name))

    assert.ok(files.length > 1, 'an oversized string must be externalized into one or more parts')
    for (const file of files) {
      const largestLine = Math.max(
        ...fs.readFileSync(file, 'utf8').split('\n').map((line) => Buffer.byteLength(line, 'utf8'))
      )
      assert.ok(largestLine < 50 * 1024, `${path.basename(file)} contains a native-read-hostile line`)
    }
    const artifact = readBrowserArtifactBundle(
      directory,
      String(result.structured?.artifactRef)
    ) as unknown as { observation: { snapshot: string } }
    assert.equal(artifact.observation.snapshot, fullSnapshot)

    let cursor: string | undefined
    let reconstructed = ''
    do {
      const section = module.readSection({
        workspaceDirectory: directory,
        artifactRef: String(result.structured?.artifactRef),
        section: 'snapshot',
        ...(cursor ? { cursor } : {})
      })
      const page = JSON.parse(section.content) as {
        text: string
        nextCursor?: string
      }
      assert.equal(section.ok, true)
      assert.ok(Buffer.byteLength(section.content, 'utf8') <= 20_000)
      assert.doesNotMatch(section.content, /\$artifactTextRef|\.part-/)
      reconstructed += page.text
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(reconstructed, fullSnapshot)
  })

  it('returns every captured page-fact item when the complete observation fits', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-full-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const links = Array.from({ length: 120 }, (_, index) => ({
      text: `样张 ${index + 1}`,
      href: `/samples/${index + 1}.jpg`
    }))
    const result = await module.execute({
      sessionId: 'session-all-facts',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/detail' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/detail',
            snapshot: '- heading "detail" [ref=e1]',
            pageFacts: { links },
            fullSnapshotTruncated: false
          },
          fullSnapshot: '- heading "detail" [ref=e1]'
        }
      })
    })
    const observation = JSON.parse(result.content) as Record<string, unknown>

    assert.equal(observation.observationMode, 'full')
    assert.equal(observation.inlineComplete, true)
    assert.equal(observation.artifactComplete, true)
    assert.equal((observation.pageFacts as { links: unknown[] }).links.length, 120)
    assert.equal(
      ((observation.pageFacts as { links: Array<{ text: string }> }).links.at(-1))?.text,
      '样张 120'
    )
  })

  it('keeps the hard transport limit even when the page has unusually many fact sections', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-limit-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const pageFacts = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`section-${index}`, [`value-${index}`]])
    )
    const result = await module.execute({
      sessionId: 'session-hard-limit',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/detail' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/detail',
            snapshot: '- heading "detail" [ref=e1]',
            pageFacts
          },
          fullSnapshot: '- heading "detail" [ref=e1]'
        }
      })
    })
    const observation = JSON.parse(result.content) as Record<string, unknown>

    assert.ok(Buffer.byteLength(result.content, 'utf8') <= browserCapabilityResultLimitBytes('open'))
    assert.equal(observation.observationMode, 'artifact')
    assert.equal(observation.inlineComplete, false)
    const packedFacts = observation.pageFacts as Record<string, unknown> | undefined
    if (packedFacts) {
      for (const value of Object.values(packedFacts)) {
        assert.ok(Array.isArray(value))
        assert.equal((value as unknown[]).length, 1)
      }
      assert.deepEqual(observation.nextActions, ['find', 'html', 'read-section'])
    } else {
      assert.deepEqual(observation.omittedInlineSections, ['observation'])
      assert.deepEqual(observation.nextActions, ['read-section'])
    }
  })

  it('marks evidence incomplete only when the complete page evidence was actually capped', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const result = await module.execute({
      sessionId: 'session-incomplete',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/MILK-181' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/MILK-181',
            title: 'MILK-181 detail',
            snapshot: '- heading "MILK-181 detail" [ref=e1]',
            truncated: true,
            fullSnapshotTruncated: true
          },
          fullSnapshot: '- heading "MILK-181 detail" [ref=e1]'
        }
      })
    })

    const compact = JSON.parse(result.content) as Record<string, unknown>
    assert.equal(compact.snapshotExcerpted, undefined)
    assert.equal(compact.evidenceIncomplete, true)
    assert.equal(compact.artifactComplete, false)
    assert.equal(compact.inlineComplete, true)
    assert.equal(compact.truncated, undefined)
  })

  it('returns occurrence-aware ARIA and top-level page-fact deltas for one document', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-delta-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const execute = async (
      fullSnapshot: string,
      pageFacts: Record<string, unknown>
    ) => module.execute({
      sessionId: 'session-delta',
      workspaceDirectory: directory,
      action: 'snapshot',
      args: {},
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'snapshot',
            documentRevision: '4:9',
            url: 'https://example.test/ABC-123',
            title: 'ABC-123',
            snapshot: fullSnapshot,
            pageFacts
          },
          fullSnapshot
        }
      })
    })
    const before = [
      '- main:',
      '  - heading "ABC-123" [ref=e1]',
      '  - text: 发行日期 2024-01-01',
      '  - text: 相同',
      '  - text: 相同',
      '  - link "演员甲" [ref=e2]',
      '  - text: 标签一',
      '  - text: 标签二',
      '  - text: 标签三',
      '  - text: 标签四'
    ].join('\n')
    const after = before.replace('2024-01-01', '2024-02-02')
    await execute(before, {
      headings: ['ABC-123'],
      metadata: { date: '2024-01-01' },
      links: [{ text: '演员甲', href: '/actor/a' }]
    })
    const result = await execute(after, {
      headings: ['ABC-123'],
      metadata: { date: '2024-02-02' },
      links: [{ text: '演员甲', href: '/actor/a' }]
    })
    const compact = JSON.parse(result.content) as Record<string, unknown>

    assert.equal(compact.observationMode, 'delta')
    assert.match(String(compact.ariaDelta), /\+ {3}- text: 发行日期 2024-02-02/)
    assert.match(String(compact.ariaDelta), /- {3}- text: 发行日期 2024-01-01/)
    assert.deepEqual(compact.pageFactsDelta, {
      changed: { metadata: { date: '2024-02-02' } },
      removedKeys: []
    })
    assert.equal(compact.pageFacts, undefined)
    assert.equal(compact.evidenceIncomplete, false)
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= 12_000)
    const artifact = readBrowserArtifactBundle(
      directory,
      String(result.structured?.artifactRef)
    ) as unknown as { observation: { snapshot: string } }
    assert.equal(artifact.observation.snapshot, after)
  })

  it('treats a scroll view revision as a full observation and invalidates prior refs', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-scroll-view-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const execute = async (input: {
      action: 'snapshot' | 'scroll'
      viewRevision: string
      snapshot: string
    }) => module.execute({
      sessionId: 'session-scroll-view',
      workspaceDirectory: directory,
      action: input.action,
      args: input.action === 'scroll' ? { direction: 'down' } : {},
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: input.action,
            documentRevision: '7:3',
            viewRevision: input.viewRevision,
            url: 'https://example.test/list',
            snapshot: input.snapshot,
            pageFacts: { headings: ['list'] },
            ...(input.action === 'scroll' ? {
              scrollState: {
                containerFingerprint: 'container-1',
                before: { scrollTop: 0, scrollHeight: 3_000, clientHeight: 600 },
                after: { scrollTop: 300, scrollHeight: 3_000, clientHeight: 600 },
                deltaY: 300,
                moved: true,
                atStart: false,
                atEnd: false,
                settled: true
              }
            } : {})
          },
          fullSnapshot: input.snapshot
        }
      })
    })

    await execute({ action: 'snapshot', viewRevision: '7:3:0', snapshot: '- link "item 1" [ref=e1]' })
    const result = await execute({
      action: 'scroll',
      viewRevision: '7:3:1',
      snapshot: '- link "item 20" [ref=e1]'
    })
    const compact = JSON.parse(result.content) as Record<string, unknown>

    assert.equal(compact.documentRevision, '7:3')
    assert.equal(compact.viewRevision, '7:3:1')
    assert.equal(compact.observationMode, 'full')
    assert.equal(compact.staleRefs, true)
    assert.match(String(compact.snapshot), /item 20/)
    assert.equal((compact.scrollState as { moved?: boolean }).moved, true)
  })

  it('records a newly appeared pageFacts section after fill without throwing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-fill-delta-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const snapshot = [
      '- main:',
      '  - textbox "search" [ref=e1]',
      '  - button "search" [ref=e2]'
    ].join('\n')
    const pageFacts = {
      forms: [{ selector: 'form.search', action: '', method: 'get' }],
      links: []
    }
    await module.execute({
      sessionId: 'session-fill-delta',
      workspaceDirectory: directory,
      action: 'open',
      args: { url: 'https://example.test/' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'open',
            documentRevision: '1:1',
            url: 'https://example.test/',
            title: 'Home',
            snapshot,
            pageFacts
          },
          fullSnapshot: snapshot
        }
      })
    })
    const result = await module.execute({
      sessionId: 'session-fill-delta',
      workspaceDirectory: directory,
      action: 'fill',
      args: { target: 'e1', text: 'ABC-123' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'fill',
            actionSucceeded: true,
            documentRevision: '1:1',
            url: 'https://example.test/',
            title: 'Home',
            snapshot,
            pageFacts: {
              ...pageFacts,
              recentRequests: [
                { method: 'GET', url: 'https://example.test/search', resourceType: 'Document' }
              ]
            }
          },
          fullSnapshot: snapshot
        }
      })
    })
    const compact = JSON.parse(result.content) as Record<string, unknown>
    assert.equal(compact.observationMode, 'delta')
    assert.deepEqual(compact.pageFactsDelta, {
      changed: {
        recentRequests: [
          { method: 'GET', url: 'https://example.test/search', resourceType: 'Document' }
        ]
      },
      removedKeys: []
    })
  })

  it('falls back explicitly to the artifact when a complete delta exceeds its budget', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-fallback-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const execute = async (snapshot: string) => module.execute({
      sessionId: 'session-fallback',
      workspaceDirectory: directory,
      action: 'snapshot',
      args: {},
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'snapshot',
            documentRevision: '2:3',
            url: 'https://example.test/detail',
            snapshot,
            pageFacts: { headings: ['detail'] }
          },
          fullSnapshot: snapshot
        }
      })
    })
    await execute(Array.from({ length: 1_000 }, (_, index) => `- text: old-${index}`).join('\n'))
    const current = Array.from({ length: 1_000 }, (_, index) => `- text: new-${index}`).join('\n')
    const result = await execute(current)
    const compact = JSON.parse(result.content) as Record<string, unknown>

    assert.equal(compact.observationMode, 'artifact')
    assert.equal(compact.inlineComplete, false)
    assert.equal(compact.deltaFallback, undefined)
    assert.equal(compact.deltaTruncated, undefined)
    assert.equal(compact.ariaDelta, undefined)
    assert.equal(compact.evidenceIncomplete, false)
    assert.ok((compact.omittedInlineSections as string[]).includes('ariaDelta'))
    assert.deepEqual(compact.nextActions, ['find', 'html', 'read-section'])
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= 12_000)
    const artifact = readBrowserArtifactBundle(
      directory,
      String(result.structured?.artifactRef)
    ) as unknown as { observation: { snapshot: string } }
    assert.equal(artifact.observation.snapshot, current)
  })

  it('isolates baselines by session and resets them when a lease is released', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-reset-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const execute = async (sessionId: string, revision: string) => module.execute({
      sessionId,
      workspaceDirectory: directory,
      action: 'snapshot',
      args: {},
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'snapshot',
            documentRevision: revision,
            url: 'https://example.test/detail',
            snapshot: '- heading "detail" [ref=e1]',
            pageFacts: { headings: ['detail'] }
          },
          fullSnapshot: '- heading "detail" [ref=e1]'
        }
      })
    })
    await execute('session-a', '1:1')
    const changedDocument = JSON.parse((await execute('session-a', '1:2')).content) as Record<string, unknown>
    const isolated = JSON.parse((await execute('session-b', '1:2')).content) as Record<string, unknown>
    module.reset('session-a')
    const reset = JSON.parse((await execute('session-a', '1:2')).content) as Record<string, unknown>

    assert.equal(changedDocument.observationMode, 'full')
    assert.equal(changedDocument.staleRefs, true)
    assert.equal(isolated.observationMode, 'full')
    assert.equal(reset.observationMode, 'full')
  })

  it('unwraps evaluate values that were unnecessarily JSON-stringified', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const result = await module.execute({
      sessionId: 'session-evaluate',
      workspaceDirectory: directory,
      action: 'evaluate',
      args: { expression: 'document.title' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'evaluate',
            url: 'https://example.test/MILK-181',
            value: JSON.stringify({ title: 'MILK-181', fields: ['发行日期', '女优'] })
          }
        }
      })
    })

    const compact = JSON.parse(result.content) as Record<string, unknown>
    assert.deepEqual(compact.value, {
      title: 'MILK-181',
      fields: ['发行日期', '女优']
    })
    assert.doesNotMatch(result.content, /\\"title\\"/)
  })

  it('keeps a successful action pending result successful and compact', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-pending-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const result = await module.execute({
      sessionId: 'session-pending',
      workspaceDirectory: directory,
      action: 'click',
      args: { target: 'e2' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'click',
            documentRevision: '5:2',
            observationMode: 'pending',
            actionSucceeded: true,
            staleRefs: true,
            url: 'https://example.test/detail'
          }
        }
      })
    })
    const compact = JSON.parse(result.content) as Record<string, unknown>

    assert.equal(compact.ok, true)
    assert.equal(compact.observationMode, 'pending')
    assert.equal(compact.actionSucceeded, true)
    assert.equal(compact.staleRefs, true)
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= 3_000)
    const artifact = JSON.parse(
      fs.readFileSync(path.join(directory, String(result.structured?.artifactRef)), 'utf8')
    ) as { observation: { evidenceIncomplete: boolean } }
    assert.equal(artifact.observation.evidenceIncomplete, true)
  })

  it('redacts typed text from the stored artifact', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-capability-'))
    directories.push(directory)
    const module = new PluginBrowserCapabilityModule()
    const result = await module.execute({
      sessionId: 'session-redaction',
      workspaceDirectory: directory,
      action: 'fill',
      args: { target: '#password', text: 'top-secret' },
      run: async () => ({
        ok: true,
        content: '',
        structured: {
          observation: {
            action: 'fill',
            documentRevision: '1:1',
            url: 'https://example.test/login',
            snapshot: '- textbox "Password" [ref=e1]'
          }
        }
      })
    })
    const artifact = fs.readFileSync(path.join(directory, String(result.structured?.artifactRef)), 'utf8')
    assert.doesNotMatch(artifact, /top-secret/)
    assert.match(artifact, /redacted 10 chars/)
  })
})
