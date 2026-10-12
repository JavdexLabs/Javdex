import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useVideoScrapeController } from './useVideoScrapeController'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('duplicate commands are locked and old completions cannot affect another detail scope', async () => {
  let result!: ReturnType<typeof useVideoScrapeController>
  let finish!: (value: Awaited<ReturnType<NonNullable<Parameters<typeof useVideoScrapeController>[0]['scrape']>>>) => void
  let calls = 0
  const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve })
  const effects: string[] = []
  function Harness({ scope }: { scope: string }) {
    result = useVideoScrapeController({ scope, video: { id: scope === 'one' ? 1 : 2, activeLibraryId: 1 },
      scrape: async () => { calls++; return pending }, onSelected: () => {},
      onPending: () => effects.push('pending'), onApplied: () => effects.push('applied'), notify: () => effects.push('notice') })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<Harness scope="one" />) })
  let first!: Promise<void>
  act(() => { first = result.execute([], 'site'); void result.execute([], 'site') })
  assert.equal(calls, 1)
  await act(async () => renderer.update(<Harness scope="two" />))
  await act(async () => { finish({ applied: true, pending: false, warnings: [], classifications: [] }); await first })
  assert.deepEqual(effects, [])
  assert.equal(result.scraping, false)
  act(() => renderer.unmount())
})

test('director-choice retry retains the choice on failure and clears it only after application', async () => {
  let result!: ReturnType<typeof useVideoScrapeController>
  const choice = { scrapedName: '同名导演', candidates: [{ id: 7, mainName: '导演甲', aliases: ['同名导演'], description: null }] }
  const submitted: Array<number | undefined> = []
  let applied = 0
  function Harness() {
    result = useVideoScrapeController({ scope: 'one', video: { id: 1, activeLibraryId: 3 }, onSelected: () => {},
      scrape: async (_video, _site, _fields, _mode, directorId) => {
        submitted.push(directorId)
        if (submitted.length === 2) throw Error('retry')
        return { applied: submitted.length > 1, pending: false, warnings: [], classifications: [], ...(submitted.length === 1 ? { directorChoice: choice } : {}) }
      }, onPending: () => {}, onApplied: () => applied++, notify: () => {} })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<Harness />) })
  await act(async () => result.execute(['director'], 'site'))
  assert.deepEqual(result.pendingDirectorChoice?.choice, choice)
  await act(async () => result.execute(['director'], 'site', undefined, 7))
  assert.deepEqual(result.pendingDirectorChoice?.choice, choice)
  assert.equal(result.directorChoiceBusy, false)
  await act(async () => result.execute(['director'], 'site', undefined, 7))
  assert.deepEqual(submitted, [undefined, 7, 7])
  assert.equal(applied, 1)
  assert.equal(result.pendingDirectorChoice, null)
  act(() => renderer.unmount())
})

test('nested navigation closes overlays without cancelling a scrape in the same video scope', async () => {
  let result!: ReturnType<typeof useVideoScrapeController>
  let finish!: (value: Awaited<ReturnType<Parameters<typeof useVideoScrapeController>[0]['scrape']>>) => void
  const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve })
  const effects: string[] = []
  let calls = 0
  function Harness({ pathname }: { pathname: string }) {
    result = useVideoScrapeController({ scope: 'video:one', video: { id: 1, activeLibraryId: 3 },
      scrape: async () => { calls++; return pending }, onSelected: () => {},
      onPending: () => effects.push('pending'), onApplied: () => effects.push('applied'), notify: () => effects.push('notice') })
    useDismissOverlaysOnNavigate(result.closeDirectorChoice, pathname)
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<Harness pathname="/libraries/3/video/1" />) })
  let command!: Promise<void>
  act(() => { command = result.execute([], 'site') })
  await act(async () => renderer.update(<Harness pathname="/libraries/3/video/1/actress/2" />))
  await act(async () => renderer.update(<Harness pathname="/libraries/3/video/1" />))
  assert.equal(result.scraping, true)
  await act(async () => result.execute([], 'site'))
  assert.equal(calls, 1, 'nested navigation must retain the duplicate-command lock')
  await act(async () => { finish({ applied: true, pending: false, warnings: [], classifications: [] }); await command })
  assert.deepEqual(effects, ['notice', 'applied'])
  assert.equal(result.scraping, false)
  act(() => renderer.unmount())
})

test('returning to a previous video scope starts idle and ignores its abandoned completion', async () => {
  let result!: ReturnType<typeof useVideoScrapeController>
  let finish!: (value: Awaited<ReturnType<Parameters<typeof useVideoScrapeController>[0]['scrape']>>) => void
  const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve })
  const effects: string[] = []
  function Harness({ scope }: { scope: string }) {
    result = useVideoScrapeController({ scope, video: { id: scope === 'one' ? 1 : 2, activeLibraryId: 1 },
      scrape: async () => pending, onSelected: () => {},
      onPending: () => effects.push('pending'), onApplied: () => effects.push('applied'), notify: () => effects.push('notice') })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<Harness scope="one" />) })
  let command!: Promise<void>
  act(() => { command = result.execute([], 'site') })
  await act(async () => renderer.update(<Harness scope="two" />))
  await act(async () => renderer.update(<Harness scope="one" />))
  assert.equal(result.scraping, false)
  await act(async () => { finish({ applied: true, pending: false, warnings: [], classifications: [] }); await command })
  assert.deepEqual(effects, [])
  assert.equal(result.pendingDirectorChoice, null)
  act(() => renderer.unmount())
})

test('closing a choice during its retry preserves the request but does not resurrect the dismissed choice on failure', async () => {
  let result!: ReturnType<typeof useVideoScrapeController>
  let fail!: (error: Error) => void
  const pending = new Promise<Awaited<ReturnType<Parameters<typeof useVideoScrapeController>[0]['scrape']>>>((_resolve, reject) => { fail = reject })
  const choice = { scrapedName: '同名导演', candidates: [{ id: 7, mainName: '导演甲', aliases: ['同名导演'], description: null }] }
  let calls = 0
  const notices: string[] = []
  function Harness() {
    result = useVideoScrapeController({ scope: 'one', video: { id: 1, activeLibraryId: 3 }, onSelected: () => {},
      scrape: async () => ++calls === 1 ? { applied: false, pending: false, warnings: [], classifications: [], directorChoice: choice } : pending,
      onPending: () => {}, onApplied: () => {}, notify: message => notices.push(message) })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<Harness />) })
  await act(async () => result.execute(['director'], 'site'))
  let command!: Promise<void>
  act(() => { command = result.execute(['director'], 'site', undefined, 7) })
  act(() => result.closeDirectorChoice())
  assert.equal(result.scraping, true)
  assert.equal(result.pendingDirectorChoice, null)
  await act(async () => { fail(Error('retry')); await command })
  assert.equal(result.scraping, false)
  assert.equal(result.pendingDirectorChoice, null)
  assert.deepEqual(notices, ['匹配失败：retry'])
  act(() => renderer.unmount())
})
