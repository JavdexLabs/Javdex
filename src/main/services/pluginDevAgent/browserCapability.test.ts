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
    assert.equal(browserCapabilityResultLimitBytes('snapshot'), 64_000)
  })

  it('keeps the complete ARIA when page facts make a new-document result exceed its budget', async () => {
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
    assert.match(String(compact.snapshot), /MILK-181 detail/)
    assert.match(String(compact.snapshot), /發行日期/)
    assert.match(String(compact.snapshot), /样张 13/)
    assert.equal(compact.observationMode, 'artifact')
    assert.equal(compact.inlineComplete, false)
    assert.equal(compact.artifactComplete, true)
    assert.equal(compact.snapshotExcerpted, undefined)
    assert.equal(compact.evidenceIncomplete, false)
    assert.equal(compact.truncated, undefined)
    assert.equal(compact.compactResult, undefined)
    assert.equal(compact.pageFacts, undefined)
    assert.deepEqual(compact.omittedInlineSections, ['pageFacts'])
    assert.deepEqual(
      (compact.pageFactsSummary as Array<Record<string, unknown>>)
        .find((item) => item.section === 'links'),
      {
        section: 'links',
        byteLength: Buffer.byteLength(JSON.stringify(pageFacts.links), 'utf8'),
        itemCount: 500
      }
    )
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

  it('stores oversized artifact strings in native-read-friendly segments', async () => {
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
    assert.deepEqual(observation.omittedInlineSections, ['observation'])
    assert.deepEqual(observation.nextActions, ['read-artifact'])
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
    assert.ok((compact.nextActions as string[]).includes('read-artifact'))
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
