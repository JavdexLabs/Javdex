import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { PlaybackSnapshot, PlaybackTarget, PlaybackControl, PlaybackViewport } from '@shared/desktop/playback'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import type { ElectronApi } from '../../../preload/index'
import { OverlayHistoryProvider } from '../interaction/OverlayHistoryContext'

const target: PlaybackTarget = { libraryId: 1, videoId: 2, resourceId: 3 }
const snapshot = (sessionId = 'first'): PlaybackSnapshot => ({
  sessionId, target, title: 'Synthetic', source: 'remote', presentation: 'expanded', presentationRevision: 1,
  phase: 'playing', paused: false, seeking: false, position: 1, duration: 120, seekable: true,
  volume: 50, muted: false, speed: 1, subtitleDelay: 0, subtitleSize: 55, tracks: [], chapters: [],
  error: null, resumePosition: null, recordingProgress: false, progressError: null,
  info: { videoCodec: null, audioCodec: null, width: null, height: null, hardwareDecoder: null, audioOutput: null, droppedFrames: null }
})
function detail(ids = [3, 4]): ScopedVideoDetail {
  return { activeLibraryId: 1, resources: [
    ...ids.map(id => ({ id, library_id: 1, video_id: 2, kind: 'local', display_name: `File ${id}` })),
    { id: 5, library_id: 1, video_id: 2, kind: 'web', display_name: 'Website' },
    { id: 6, library_id: 9, video_id: 2, kind: 'local', display_name: 'Other library' },
    { id: 7, library_id: 1, video_id: 9, kind: 'local', display_name: 'Other video' }
  ] } as ScopedVideoDetail
}
let changed: (value: PlaybackSnapshot | null) => void = () => {}
const opened: Array<{ target: PlaybackTarget; privateSession: boolean }> = []
const external: unknown[][] = []
const controls: Array<{ id: string; command: PlaybackControl }> = []
const queried: unknown[][] = []
const viewports: PlaybackViewport[] = []
let getDetail = async (): Promise<ScopedVideoDetail | null> => detail()
let open = async () => ({ ok: true })
let openExternal = async () => ({ ok: true })
const fake = {
  playback: {
    snapshot: async () => snapshot(),
    onChanged: (listener: typeof changed) => { changed = listener; return () => { changed = () => {} } },
    open: async (value: PlaybackTarget, options: { privateSession: boolean }) => { opened.push({ target: value, privateSession: options.privateSession }); return open() },
    control: async (id: string, command: PlaybackControl) => { controls.push({ id, command }) },
    viewport: async (value: PlaybackViewport) => { viewports.push(value) }
  },
  player: { openResource: async (...args: unknown[]) => { external.push(args); return openExternal() } },
  videos: { get: async (...args: unknown[]) => { queried.push(args); return getDetail() } }
} as unknown as ElectronApi
const history = {
  state: null as unknown,
  pushState(state: unknown) { this.state = state },
  go() { this.state = null; queueMicrotask(() => window.dispatchEvent(Object.assign(new Event('popstate'), { state: null }))) }
}
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
  api: fake, location: { href: 'http://localhost/' }, history, setTimeout, clearTimeout, setInterval, clearInterval
}) })
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  body: { style: { overflow: '' } }, activeElement: null, visibilityState: 'visible', querySelectorAll: () => []
} })
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
let renderer: TestRenderer.ReactTestRenderer | undefined
let Select: typeof import('../components/SelectControl').default
async function mount(options?: TestRenderer.TestRendererOptions): Promise<void> {
  const Panel = (await import('./PlaybackPanel')).default
  Select = (await import('../components/SelectControl')).default
  await act(async () => { renderer = TestRenderer.create(<OverlayHistoryProvider><Panel /></OverlayHistoryProvider>, options) })
}
function button(label: string) {
  const result = renderer!.root.findAllByType('button').find(node => node.props['aria-label'] === label || node.children.includes(label))
  assert.ok(result, label)
  return result
}
async function options(): Promise<void> { await act(async () => button('播放选项').props.onClick()) }
function source() { return renderer!.root.findAllByType(Select).find(node => node.props['aria-label'] === '播放来源')! }
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  opened.length = external.length = controls.length = queried.length = viewports.length = 0
  getDetail = async () => detail(); open = openExternal = async () => ({ ok: true }); history.state = null
})

test('options offer only files belonging to the playing video and preserve private playback on explicit source selection', async () => {
  await mount(); await options()
  assert.deepEqual(queried, [[{ kind: 'library', libraryId: 1 }, 2]])
  assert.deepEqual(React.Children.toArray(source().props.children).map(child => (child as React.ReactElement).props.value), [3, 4])
  await act(async () => source().props.onChange({ target: { value: '3' } }))
  await act(async () => source().props.onChange({ target: { value: '6' } }))
  assert.equal(opened.length, 0)
  await act(async () => source().props.onChange({ target: { value: '4' } }))
  assert.deepEqual(opened, [{ target: { ...target, resourceId: 4 }, privateSession: true }])
})

test('source selection synchronously excludes duplicate opens while its request is pending', async () => {
  let finish!: (value: { ok: boolean }) => void
  open = () => new Promise(resolve => { finish = resolve })
  await mount(); await options()
  const select = source().props.onChange
  await act(async () => { select({ target: { value: '4' } }); select({ target: { value: '4' } }) })
  assert.equal(opened.length, 1)
  assert.equal(source().props.disabled, true)
  await act(async () => finish({ ok: true }))
})

test('external open is available during normal playback and stops that session only after a successful open', async () => {
  let finish!: (value: { ok: boolean }) => void
  openExternal = () => new Promise(resolve => { finish = resolve })
  await mount(); await options()
  const click = button('使用外部播放器打开').props.onClick
  await act(async () => { click(); click() })
  assert.deepEqual(external, [[1, 3, 2, 'external']])
  assert.equal(controls.length, 0)
  await act(async () => finish({ ok: true }))
  assert.deepEqual(controls, [{ id: 'first', command: { kind: 'stop' } }])
})

test('an old external request cannot stop a replacement playback session', async () => {
  let finish!: (value: { ok: boolean }) => void
  openExternal = () => new Promise(resolve => { finish = resolve })
  await mount(); await options()
  await act(async () => button('使用外部播放器打开').props.onClick())
  await act(async () => changed(snapshot('replacement')))
  await act(async () => finish({ ok: true }))
  assert.equal(controls.length, 0)
})

test('external open failure leaves the built-in playback running', async () => {
  openExternal = async () => ({ ok: false })
  await mount(); await options()
  await act(async () => button('使用外部播放器打开').props.onClick())
  assert.equal(external.length, 1)
  assert.equal(controls.length, 0)
})

test('source selection retains an explicitly enabled recording session, including when the current resource was removed', async () => {
  getDetail = async () => detail([4])
  await mount()
  await act(async () => changed({ ...snapshot(), recordingProgress: true }))
  await options()
  assert.equal(source().props.disabled, false)
  await act(async () => source().props.onChange({ target: { value: '4' } }))
  assert.deepEqual(opened, [{ target: { ...target, resourceId: 4 }, privateSession: false }])
})

test('late source queries are discarded after session replacement', async () => {
  let finish!: (value: ScopedVideoDetail) => void
  getDetail = () => new Promise(resolve => { finish = resolve })
  await mount(); await options()
  assert.equal(source().props.disabled, true)
  await act(async () => changed(snapshot('replacement')))
  await act(async () => finish(detail([3, 99])))
  getDetail = async () => detail([3, 8])
  await options()
  assert.deepEqual(React.Children.toArray(source().props.children).map(child => (child as React.ReactElement).props.value), [3, 8])
})

test('source query failure keeps the current playback and can be retried by reopening options', async () => {
  getDetail = async () => { throw Error('Private server details') }
  await mount(); await options()
  assert.equal(source().props.disabled, true)
  assert.equal(JSON.stringify(renderer!.toJSON()).includes('Private server details'), false)
  assert.equal(controls.length, 0)
  await options()
  getDetail = async () => detail()
  await options()
  assert.equal(source().props.disabled, false)
})

test('viewport polling hides only intersecting visible toast surfaces and restores the same playback session', async context => {
  let poll = (): void => {}
  context.mock.method(window, 'setInterval', (callback: () => void) => { poll = callback; return 1 })
  context.mock.method(window, 'clearInterval', () => {})
  const video = { x: 10, y: 20, width: 100, height: 80, left: 10, top: 20, right: 110, bottom: 100 }
  let surfaceBounds = { left: 200, top: 20, right: 300, bottom: 60 }
  let surfaceVisible = true
  const surface = { getBoundingClientRect: () => surfaceBounds, checkVisibility: () => surfaceVisible }
  let surfaces: typeof surface[] = []
  context.mock.method(document, 'querySelectorAll', (selector: string) => {
    assert.equal(selector, '[data-native-playback-occluder]')
    return surfaces
  })
  await mount({ createNodeMock: element => element.type === 'button' && String(element.props['aria-label']).startsWith('视频画面')
    ? { getBoundingClientRect: () => video, closest: () => null } : null })
  assert.deepEqual(viewports.map(value => value.visible), [true])
  surfaces = [surface]
  await act(async () => poll())
  assert.equal(viewports.length, 1, 'a disjoint toast does not hide video or resend unchanged geometry')
  surfaceBounds = { left: 109, top: 20, right: 200, bottom: 60 }
  await act(async () => { poll(); poll() })
  assert.deepEqual(viewports.map(value => value.visible), [true, false])
  surfaceVisible = false
  await act(async () => poll())
  assert.deepEqual(viewports.map(value => value.visible), [true, false, true])
  surfaceVisible = true
  await act(async () => poll())
  surfaces = []
  await act(async () => poll())
  assert.deepEqual(viewports.map(value => value.visible), [true, false, true, false, true])
  assert.ok(viewports.every(value => value.sessionId === 'first' && value.presentation === 'expanded'))
  assert.deepEqual(controls, [], 'visual occlusion neither pauses nor stops the decoder')
  assert.deepEqual(opened, [], 'restoring video does not reopen the source')
})
