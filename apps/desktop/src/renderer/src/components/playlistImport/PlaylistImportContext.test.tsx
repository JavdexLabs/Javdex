import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  PlaylistImportControlCommand,
  PlaylistImportSnapshot,
  PlaylistImportSnapshotChangedEvent,
  PlaylistImportStartInput
} from '@shared/playlistImportTypes'

const starts: PlaylistImportStartInput[] = []
const controls: Array<{ runId: string; command: PlaylistImportControlCommand }> = []
const externalLinks: string[] = []
let current: PlaylistImportSnapshot
let changed: ((event: PlaylistImportSnapshotChangedEvent) => void) | undefined
let cancelError: Error | undefined
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient
let location = ''
const api = {
  mediaLibraries: { list: async () => [
    { id: 1, name: 'Archived', status: 'archived', isDefault: true },
    { id: 2, name: 'Default', status: 'active', isDefault: true },
    { id: 3, name: 'Other', status: 'active', isDefault: false }
  ] },
  externalLinks: { open: async (url: string) => { externalLinks.push(url) } },
  playlistImport: {
    start: async (input: PlaylistImportStartInput) => { starts.push(input); return current },
    snapshot: async () => current,
    control: async (runId: string, command: PlaylistImportControlCommand) => {
      controls.push({ runId, command })
      if (cancelError) throw cancelError
      return { ...current, phase: 'cancelled' as const }
    },
    onSnapshotChanged: (listener: typeof changed) => {
      changed = listener
      return () => { changed = undefined }
    }
  }
}
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: Object.assign(new EventTarget(), { api, setInterval, clearInterval })
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: Object.assign(new EventTarget(), { body: { style: { overflow: '' } }, activeElement: null })
})

beforeEach(() => {
  starts.length = 0
  controls.length = 0
  externalLinks.length = 0
  cancelError = undefined
  current = {
    runId: 'run-1', revision: 1, cursor: 0, phase: 'discovering-list', summary: 'Reading',
    frozenInput: {
      sourceUrl: 'https://example.test/list', displayUrl: 'https://example.test/list',
      sourceHost: 'example.test', targetLibraryId: 2, targetLibraryNameAtStart: 'Default',
      destination: { kind: 'create' }, autoCreateUnmatchedVideos: true,
      saveDetailLinks: true, saveSourcePlaylistLink: false, policyVersion: 1
    },
    progress: {
      pagesRead: 0, scrollWindowsRead: 0, sourceItems: 0, uniqueItems: 0,
      directReuses: 0, detailPending: 0, userDecisionsPending: 0,
      plannedCreates: 0, skippedItems: 0, appliedItems: 0
    }
  }
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  client?.clear()
})

async function mount(mode: 'local' | 'remote' = 'local'): Promise<void> {
  const { PlaylistImportProvider, usePlaylistImport } = await import('./PlaylistImportContext')
  const { DesktopSessionContext } = await import('../../desktop/DesktopSessionContext')
  function OpenImporter(): JSX.Element {
    const importer = usePlaylistImport()
    location = useLocation().pathname
    return <button onClick={() => importer.open()}>Open</button>
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DesktopSessionContext.Consumer>{value => (
            <DesktopSessionContext.Provider value={{ ...value, session: { ...value.session, mode } }}>
              <PlaylistImportProvider><OpenImporter /></PlaylistImportProvider>
            </DesktopSessionContext.Provider>
          )}</DesktopSessionContext.Consumer>
        </MemoryRouter>
      </QueryClientProvider>
    )
  })
  await click('Open')
}
function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
}
function button(label: string): TestRenderer.ReactTestInstance {
  const found = renderer!.root.findAllByType('button').find(node => text(node) === label)
  assert.ok(found, label)
  return found
}
async function click(label: string): Promise<void> {
  const node = button(label)
  assert.ok(!node.props.disabled, `${label} must be enabled`)
  await act(async () => node.props.onClick())
}
async function start(): Promise<void> {
  await act(async () => renderer!.root.findByProps({ type: 'url' }).props.onChange({
    target: { value: '  https://example.test/list  ' }
  }))
  await click('开始导入')
}
async function publish(snapshot: PlaylistImportSnapshot): Promise<void> {
  current = snapshot
  await act(async () => changed!({ runId: snapshot.runId, revision: snapshot.revision }))
}

for (const mode of ['local', 'remote'] as const) {
  it(`submits active default library and safe write defaults in ${mode} mode`, async () => {
    await mount(mode)
    assert.equal(button('开始导入').props.disabled, true)
    const { default: SelectControl } = await import('../SelectControl')
    const options = renderer!.root.findAllByType(SelectControl).flatMap(node =>
      React.Children.toArray(node.props.children).filter(React.isValidElement)
        .map(option => (option as React.ReactElement<{ children: string }>).props.children)
    )
    assert.ok(!options.includes('Archived'))
    assert.equal(options.includes('追加到清单'), mode === 'local')
    await start()
    const { idempotencyKey, ...input } = starts[0]
    assert.ok(idempotencyKey)
    assert.deepEqual(input, {
      sourceUrl: 'https://example.test/list', targetLibraryId: 2,
      autoCreateUnmatchedVideos: true, saveDetailLinks: true, saveSourcePlaylistLink: false,
      destination: { kind: 'create' }
    })
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 1)
  })
}

it('requires confirmation and closes only after successful host cancellation', async () => {
  await mount()
  await start()
  await act(async () => {
    window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }))
    const backdrop = renderer!.root.find(node => typeof node.type === 'string' && Boolean(node.props['data-modal-id']))
    const target = {}
    backdrop.props.onMouseDown({ target, currentTarget: target })
  })
  assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 1, 'Escape and backdrop must not dismiss a running import')
  assert.equal(controls.length, 0, 'dismissal must not implicitly cancel the host task')
  const { default: ConfirmModal } = await import('../ConfirmModal')
  for (const failure of [true, false]) {
    cancelError = failure ? new Error('host unavailable') : undefined
    await click('终止任务')
    assert.equal(controls.length, failure ? 0 : 1)
    const confirm = renderer!.root.findByType(ConfirmModal)
    await act(async () => confirm.props.onConfirm())
    assert.equal(controls.at(-1)?.runId, 'run-1')
    assert.equal(controls.at(-1)?.command.kind, 'cancel')
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, failure ? 1 : 0)
    if (failure) assert.match(text(renderer!.root.findByProps({ role: 'alert' })), /host unavailable/)
  }
})

it('invalidates stale identity choices and opens evidence through the host', async () => {
  const item = {
    itemId: 10, itemRevision: 1, code: 'ABC-001', detailUrl: 'https://example.test/1',
    candidates: [{
      videoId: 7, code: 'ABC-001', title: 'Candidate', publisher: 'Studio', releaseDate: '2020-01-02',
      libraryIds: [2], libraryNames: ['Default'], belongsToTargetLibrary: true,
      resourceKinds: ['local'], relatedLinks: [{ label: 'Evidence', url: 'https://example.test/evidence' }]
    }]
  }
  current = { ...current, phase: 'waiting_user', attention: { kind: 'identity-review', items: [item] } }
  await mount()
  await start()
  const review = renderer!.root.findByProps({ 'aria-label': '身份确认' })
  assert.match(text(review), /Studio.*2020-01-02.*Default.*local/)
  await click('Evidence')
  assert.deepEqual(externalLinks, ['https://example.test/evidence'])
  const choose = async () => {
    await act(async () => renderer!.root.findAllByProps({ role: 'radio' })[0].props.onClick())
  }
  await choose()
  assert.equal(button('应用身份选择').props.disabled, false)
  await publish({ ...current, revision: 2, attention: { kind: 'identity-review', items: [{ ...item, itemRevision: 2 }] } })
  assert.equal(button('应用身份选择').props.disabled, true)
  await choose()
  await click('应用身份选择')
  assert.deepEqual(controls[0].command, {
    kind: 'resolve-identities', expectedRevision: 2,
    idempotencyKey: controls[0].command.idempotencyKey,
    decisions: [{ itemId: 10, choice: { kind: 'existing', videoId: 7 } }]
  })
})

it('refreshes catalog data once on completion and closes before navigating to the playlist', async () => {
  const { onPlaylistImportCompleted } = await import('./events')
  const { videoKeys } = await import('../../query/queryKeys')
  const completed: number[] = []
  const unsubscribe = onPlaylistImportCompleted(id => completed.push(id))
  try {
    await mount()
    client.setQueryData(videoKeys.all, ['old'])
    await start()
    const outcome = {
      playlistId: 12, playlistName: 'Imported', targetLibraryId: 2, targetLibraryName: 'Default',
      pagesRead: 2, sourceItems: 3, uniqueDetailUrls: 3, totalItems: 3, reusedVideos: 2,
      directReuses: 1, detailReuses: 1, userSelectedReuses: 0, crossLibraryReuses: 1,
      createdVideos: 1, targetLibraryMembersCreated: 1, skippedVideos: 0, addedToPlaylist: 3,
      alreadyInPlaylist: 0, relatedLinksAdded: 3, playlistRelatedLinksAdded: 0,
      externalDuplicateItems: 0, convergedExternalItems: 0,
      reuseLibraryDistribution: [{ libraryId: 2, libraryName: 'Default', reusedVideos: 2 }]
    }
    await publish({ ...current, phase: 'completed', revision: 2, outcome })
    assert.equal(client.getQueryState(videoKeys.all)?.isInvalidated, true)
    const summary = text(renderer!.root.findByProps({ 'aria-label': '导入结果' }))
    assert.match(summary, /读取 2 页、3 条/)
    assert.match(summary, /清单“Imported”/)
    assert.match(summary, /Default 2/)
    await publish({ ...current, revision: 3 })
    assert.deepEqual(completed, [12])
    await click('查看清单')
    assert.equal(location, '/playlists/12')
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 0)
  } finally { unsubscribe() }
})
