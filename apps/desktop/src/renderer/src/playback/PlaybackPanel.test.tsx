import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import TestRenderer, { act } from 'react-test-renderer'
import type { PlaybackSnapshot, PlaybackTarget, PlaybackControl, PlaybackViewport } from '@shared/desktop/playback'
import type { AiSubtitleSnapshot } from '@shared/desktop/aiSubtitles'
import type { LocalModelSnapshot } from '@shared/desktop/localModels'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import type { ElectronApi } from '../../../preload/index'
import { OverlayHistoryProvider } from '../interaction/OverlayHistoryContext'
import { interactionLayers, type InteractionLayer } from '../interaction/interactionLayers'
import { renderedText } from '../test/renderedText'

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
const aiSnapshot = (): AiSubtitleSnapshot => ({ sessionId: null, supported: false, installed: false, enabled: false,
  phase: 'idle', activeStart: null, recognizedSeconds: 0, translatedSeconds: 0, duration: null,
  display: 'bilingual', fontSize: 42, error: null })
let aiState = aiSnapshot()
let aiChanged: (value: AiSubtitleSnapshot) => void = () => {}
let aiCommand = async (): Promise<AiSubtitleSnapshot> => aiState
const localModels = (): LocalModelSnapshot => ({
  revision: 'fixture', supported: false, directory: '/fixture/models', defaultDirectory: '/fixture/models', downloadSource: 'official',
  translation: 'app-default', translationModel: 'qwen3', models: [], operation: null, activeModel: null, activeVariant: null,
  downloadBytes: 0, downloadTotal: 0, downloadLabel: null, error: null,
  usage: { subtitleRecognition: { model: 'kotoba', variant: 'fixture' }, subtitleTranslation: { model: 'qwen3', variant: 'fixture' },
    textTranslation: { model: 'qwen3', variant: 'fixture', mode: 'app-default' } }
})
const fake = {
  settings: { getLocalModels: async () => localModels(), onLocalModelsChanged: () => () => {} },
  playback: {
    aiSubtitleSnapshot: async () => aiState,
    onAiSubtitleChanged: (listener: typeof aiChanged) => { aiChanged = listener; return () => { aiChanged = () => {} } },
    aiSubtitleCommand: () => aiCommand(),
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
  body: { style: { overflow: '' } }, activeElement: null, visibilityState: 'visible', hasFocus: () => true, querySelectorAll: () => []
} })
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
let renderer: TestRenderer.ReactTestRenderer | undefined
let Select: typeof import('../components/SelectControl').default
async function mount(options?: TestRenderer.TestRendererOptions): Promise<void> {
  const Panel = (await import('./PlaybackPanel')).default
  Select = (await import('../components/SelectControl')).default
  await act(async () => { renderer = TestRenderer.create(<MemoryRouter><OverlayHistoryProvider><Panel /></OverlayHistoryProvider></MemoryRouter>, options) })
}
function button(label: string) {
  const result = renderer!.root.findAllByType('button').find(node => node.props['aria-label'] === label || renderedText(node) === label)
  assert.ok(result, label)
  return result
}
async function options(): Promise<void> { await act(async () => button('播放设置').props.onClick()) }
function source() { return renderer!.root.findAllByType(Select).find(node => node.props['aria-label'] === '播放来源')! }
function seekKey(key: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean } = {}) {
  const event = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers,
    nativeEvent: { isComposing: modifiers.isComposing ?? false }, defaultPrevented: false, propagationStopped: false,
    preventDefault: () => { event.defaultPrevented = true }, stopPropagation: () => { event.propagationStopped = true } }
  return event
}
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  opened.length = external.length = controls.length = queried.length = viewports.length = 0
  getDetail = async () => detail(); open = openExternal = async () => ({ ok: true }); history.state = null
  aiState = aiSnapshot(); aiCommand = async () => aiState
})

test('AI subtitle command results cannot overwrite newer subtitle events', async () => {
  aiState = { ...aiSnapshot(), supported: true, installed: true }
  let finish!: (value: AiSubtitleSnapshot) => void
  aiCommand = () => new Promise(resolve => { finish = resolve })
  await mount(); await options()
  const display = () => renderer!.root.findAllByType(Select).find(node => node.props['aria-label'] === 'AI 字幕显示')!
  await act(async () => display().props.onChange({ target: { value: 'japanese' } }))
  await act(async () => aiChanged({ ...aiState, display: 'chinese' }))
  await act(async () => finish({ ...aiState, display: 'japanese' }))
  assert.equal(display().props.value, 'chinese')
  assert.equal(display().props.disabled, false)
})

test('a replacement playback session releases AI subtitle busy state and rejects the previous result', async () => {
  aiState = { ...aiSnapshot(), supported: true, installed: true }
  let finish!: (value: AiSubtitleSnapshot) => void
  aiCommand = () => new Promise(resolve => { finish = resolve })
  const AiSettings = (await import('./AiSubtitleSettings')).default
  const component = (id: string) => <MemoryRouter><OverlayHistoryProvider><AiSettings playback={snapshot(id)} /></OverlayHistoryProvider></MemoryRouter>
  await act(async () => { renderer = TestRenderer.create(component('first')) })
  await act(async () => button('开启 AI 字幕').props.onClick())
  assert.equal(button('开启 AI 字幕').props.disabled, true)
  await act(async () => renderer!.update(component('second')))
  assert.equal(button('开启 AI 字幕').props.disabled, false)
  await act(async () => finish({ ...aiState, display: 'japanese', enabled: true, sessionId: 'first' }))
  assert.equal(button('开启 AI 字幕').props.disabled, false)
  const SelectControl = (await import('../components/SelectControl')).default
  assert.equal(renderer!.root.findAllByType(SelectControl).find(node => node.props['aria-label'] === 'AI 字幕显示')!.props.value, 'bilingual')
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

test('progress arrows after a pointer seek accumulate pending targets and never change pause intent', async () => {
  await mount()
  const slider = () => renderer!.root.findAllByType('input').find(node => node.props['aria-label'] === '播放进度')!
  for (const paused of [false, true]) {
    const current = { ...snapshot(), position: 10, paused, phase: paused ? 'paused' as const : 'playing' as const }
    await act(async () => changed(current))
    controls.length = 0
    await act(async () => slider().props.onChange({ target: { value: '60' } }))
    await act(async () => slider().props.onPointerUp())
    const firstRight = seekKey('ArrowRight')
    await act(async () => slider().props.onKeyDown(firstRight))
    assert.equal(firstRight.defaultPrevented, true, 'avoid the browser default 0.1-second increment')
    assert.equal(firstRight.propagationStopped, true, 'one keypress must not also reach the player shortcut')
    assert.equal(slider().props.value, 65, 'start from the clicked target while its old clock remains pending')
    await act(async () => changed({ ...current, seeking: true, position: 12 }))
    assert.equal(slider().props.value, 65)
    await act(async () => slider().props.onKeyDown(seekKey('ArrowRight')))
    assert.equal(slider().props.value, 70)
    await act(async () => changed({ ...current, position: 65 }))
    assert.equal(slider().props.value, 70, 'the preceding keyboard seek acknowledgement cannot overwrite the latest preview')
    await act(async () => slider().props.onKeyDown(seekKey('ArrowLeft', { shiftKey: true })))
    assert.equal(slider().props.value, 40)
    await act(async () => { slider().props.onKeyUp(); slider().props.onBlur() })
    assert.deepEqual(controls, [60, 65, 70, 40].map(seconds => ({ id: 'first', command: { kind: 'seek', seconds } })),
      `keydown must commit once without pause or duplicate release commands while paused=${paused}`)
    await act(async () => changed({ ...current, position: 70 }))
    assert.equal(slider().props.value, 40)
    await act(async () => changed({ ...current, position: 40 }))
    await act(async () => changed({ ...current, position: 41 }))
    assert.equal(slider().props.value, 41, 'after the final acknowledgement the thumb follows the native clock again')
  }
})

test('progress keyboard focus reveals fullscreen controls and cancels their auto-hide timer', async context => {
  let nextTimer = 1
  const hideTimers = new Map<number, () => void>()
  context.mock.method(window, 'setTimeout', (callback: () => void, milliseconds: number) => {
    const id = nextTimer++
    if (milliseconds === 3000) hideTimers.set(id, callback)
    return id
  })
  context.mock.method(window, 'clearTimeout', (id: number) => { hideTimers.delete(id) })
  await mount()
  await act(async () => changed({ ...snapshot(), presentation: 'fullscreen', rendererFullscreenControls: true, nativeVideoFocused: false }))
  const panel = () => renderer!.root.find(node => node.props['data-playback-session'] === 'first')
  const slider = renderer!.root.findAllByType('input').find(node => node.props['aria-label'] === '播放进度')!
  assert.equal(panel().props['data-controls-visible'], false)
  assert.equal(hideTimers.size, 1)
  await act(async () => slider.props.onKeyDown(seekKey('ArrowRight')))
  assert.equal(panel().props['data-controls-visible'], true)
  assert.equal(hideTimers.size, 0, 'focused keyboard adjustment must cancel auto-hide, rather than merely restart it')
  assert.deepEqual(controls, [{ id: 'first', command: { kind: 'seek', seconds: 6 } }])
})

test('progress keyboard seeks clamp both bounds and start from an uncommitted pointer draft', async () => {
  await mount()
  const slider = () => renderer!.root.findAllByType('input').find(node => node.props['aria-label'] === '播放进度')!
  await act(async () => changed({ ...snapshot(), position: 60 }))
  await act(async () => slider().props.onChange({ target: { value: '3' } }))
  await act(async () => slider().props.onKeyDown(seekKey('ArrowLeft')))
  assert.equal(slider().props.value, 0)
  await act(async () => { slider().props.onPointerUp(); slider().props.onKeyUp(); slider().props.onBlur() })
  await act(async () => changed({ ...snapshot(), position: 0 }))
  await act(async () => changed({ ...snapshot(), position: 119 }))
  await act(async () => slider().props.onKeyDown(seekKey('ArrowRight', { shiftKey: true })))
  assert.equal(slider().props.value, 120)
  assert.deepEqual(controls, [{ id: 'first', command: { kind: 'seek', seconds: 0 } }, { id: 'first', command: { kind: 'seek', seconds: 120 } }])
})

test('progress keyboard handling leaves modified input, disabled seeking, child layers and volume alone', async () => {
  await mount()
  const slider = () => renderer!.root.findAllByType('input').find(node => node.props['aria-label'] === '播放进度')!
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    const event = seekKey('ArrowRight', modifiers)
    await act(async () => slider().props.onKeyDown(event))
    assert.equal(event.defaultPrevented, false)
    assert.equal(event.propagationStopped, false)
  }
  for (const value of [{ ...snapshot(), seekable: false }, { ...snapshot(), phase: 'opening' as const },
    { ...snapshot(), resumePosition: 30 }, { ...snapshot(), duration: null }]) {
    await act(async () => changed(value))
    assert.equal(slider().props.disabled, true)
    const event = seekKey('ArrowRight')
    await act(async () => slider().props.onKeyDown(event))
    assert.equal(event.defaultPrevented, false)
  }
  await act(async () => changed(snapshot()))
  const removeChild = interactionLayers.register({ id: 'seek-test-child', root: () => null })
  try {
    const event = seekKey('ArrowRight')
    await act(async () => slider().props.onKeyDown(event))
    assert.equal(event.defaultPrevented, false)
  } finally { removeChild() }
  assert.deepEqual(controls, [], 'ignored input must not send seek or pause commands')
  const volume = renderer!.root.findAllByType('input').find(node => node.props['aria-label'] === '音量')!
  assert.equal(volume.props.onKeyDown, undefined, 'the volume range retains its own browser keyboard behavior')
  await act(async () => volume.props.onChange({ target: { value: '51' } }))
  assert.deepEqual(controls, [{ id: 'first', command: { kind: 'volume', value: 51 } }])
})

test('released seek thumb ignores stale clocks until native seek acknowledgement, then follows playback', async () => {
  await mount()
  const slider = () => renderer!.root.findAllByType('input').find(node => node.props['aria-label'] === '播放进度')!
  await act(async () => slider().props.onChange({ target: { value: '60' } }))
  await act(async () => { slider().props.onPointerUp(); slider().props.onBlur() })
  assert.deepEqual(controls, [{ id: 'first', command: { kind: 'seek', seconds: 60 } }])
  assert.equal(slider().props.value, 60, 'accepting the command cannot reset the thumb')
  await act(async () => changed({ ...snapshot(), position: 2 }))
  assert.equal(slider().props.value, 60, 'the old native clock may arrive after pointer-up')
  await act(async () => changed({ ...snapshot(), seeking: true, position: 3 }))
  assert.equal(slider().props.value, 60)
  await act(async () => changed({ ...snapshot(), seeking: true, position: 60 }))
  assert.equal(slider().props.value, 60)
  await act(async () => changed({ ...snapshot(), seeking: false, position: 60.25 }))
  assert.equal(slider().props.value, 60.25)
  await act(async () => changed({ ...snapshot(), position: 61 }))
  assert.equal(slider().props.value, 61)
})

test('replacement seeks, drag cancellation and session replacement release only their own preview', async () => {
  await mount()
  const slider = () => renderer!.root.findAllByType('input').find(node => node.props['aria-label'] === '播放进度')!
  await act(async () => slider().props.onChange({ target: { value: '60' } }))
  await act(async () => slider().props.onKeyUp())
  await act(async () => slider().props.onChange({ target: { value: '90' } }))
  await act(async () => changed({ ...snapshot(), position: 60 }))
  assert.equal(slider().props.value, 90, 'acknowledging the previous seek cannot overwrite a new drag')
  await act(async () => slider().props.onPointerUp())
  await act(async () => changed({ ...snapshot(), position: 61 }))
  assert.equal(slider().props.value, 90)
  await act(async () => changed({ ...snapshot(), position: 90.1 }))
  assert.equal(slider().props.value, 90.1)
  await act(async () => slider().props.onChange({ target: { value: '40' } }))
  await act(async () => slider().props.onPointerCancel())
  assert.equal(slider().props.value, 90.1)
  await act(async () => slider().props.onChange({ target: { value: '80' } }))
  await act(async () => slider().props.onPointerUp())
  await act(async () => changed(snapshot('replacement')))
  assert.equal(slider().props.value, 1)
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

test('owned dropdowns keep video visible unless their surface overlaps; nested modals still hide it', async context => {
  let poll = (): void => {}
  context.mock.method(window, 'setInterval', (callback: () => void) => { poll = callback; return 1 })
  context.mock.method(window, 'clearInterval', () => {})
  let playerLayer: InteractionLayer | undefined
  const register = interactionLayers.register.bind(interactionLayers)
  context.mock.method(interactionLayers, 'register', (layer: InteractionLayer) => {
    if (layer.modal && !layer.parentId) playerLayer = layer
    return register(layer)
  })
  const video = { x: 10, y: 20, width: 100, height: 80, left: 10, top: 20, right: 110, bottom: 100 }
  let menuBounds = { left: 200, top: 20, right: 300, bottom: 60 }
  const menu = { getBoundingClientRect: () => menuBounds, checkVisibility: () => true }
  let surfaces: typeof menu[] = []
  context.mock.method(document, 'querySelectorAll', () => surfaces)
  await mount({ createNodeMock: element => element.type === 'button' && String(element.props['aria-label']).startsWith('视频画面')
    ? { getBoundingClientRect: () => video, closest: () => null } : null })
  assert.ok(playerLayer)
  const removeSelect = register({ id: 'playback-dropdown', parentId: playerLayer.id, root: () => null })
  context.after(removeSelect)
  surfaces = [menu]
  await act(async () => poll())
  assert.equal(interactionLayers.isTop(playerLayer.id), false, 'dropdown owns Escape and keyboard input')
  assert.deepEqual(viewports.map(value => value.visible), [true], 'a dropdown in the option rail does not black out video')
  menuBounds = { left: 109, top: 20, right: 200, bottom: 60 }
  await act(async () => poll())
  assert.deepEqual(viewports.map(value => value.visible), [true, false])
  menuBounds = { left: 200, top: 20, right: 300, bottom: 60 }
  await act(async () => poll())
  const removeModal = register({ id: 'playback-confirmation', parentId: playerLayer.id, modal: true, root: () => null })
  context.after(removeModal)
  await act(async () => poll())
  removeModal()
  removeSelect()
  surfaces = []
  await act(async () => poll())
  assert.deepEqual(viewports.map(value => value.visible), [true, false, true, false, true])
  assert.deepEqual(controls, [], 'opening and closing menus does not pause or stop the decoder')
  assert.deepEqual(opened, [], 'the same playback source remains open')
})

test('Windows fullscreen uses the classic toolbar and the same three settings tabs', async () => {
  await mount()
  await act(async () => changed({ ...snapshot(), presentation: 'fullscreen', rendererFullscreenControls: true, interactionSequence: 1 }))
  assert.ok(button('退出全屏'))
  assert.ok(renderer!.root.findAllByType(Select).some(node => node.props['aria-label'] === '快捷音轨'))
  await options()
  assert.ok(source())
  const panels = () => renderer!.root.findAll(node => node.props.role === 'tabpanel')
  assert.equal(panels().filter(node => !node.props.hidden).length, 1)
  await act(async () => button('字幕').props.onClick())
  assert.equal(panels().find(node => String(node.props.id).endsWith('-subtitle'))!.props.hidden, false)
  await act(async () => button('信息').props.onClick())
  assert.equal(panels().find(node => String(node.props.id).endsWith('-info'))!.props.hidden, false)
  assert.deepEqual(controls, [], 'opening settings never replaces the native decoder or changes pause intent')
  await act(async () => button('关闭播放设置').props.onClick())
  assert.equal(button('播放设置').props['aria-expanded'], false)
})

test('fullscreen volume previews survive old snapshots and resume following confirmed volume', async () => {
  await mount()
  const current = { ...snapshot(), presentation: 'fullscreen' as const, rendererFullscreenControls: true }
  await act(async () => changed(current))
  const slider = () => renderer!.root.findAllByType('input').find(node => node.props['aria-label'] === '音量')!
  await act(async () => slider().props.onChange({ target: { value: '75' } }))
  assert.equal(slider().props.value, 75)
  await act(async () => changed({ ...current, volume: 51 }))
  assert.equal(slider().props.value, 75)
  await act(async () => changed({ ...current, volume: 75 }))
  await act(async () => changed({ ...current, volume: 76 }))
  assert.equal(slider().props.value, 76)
  assert.deepEqual(controls, [{ id: 'first', command: { kind: 'volume', value: 75 } }])
})
test('a docked resume decision can always expand back to its resume controls', async () => {
  await mount()
  await act(async () => changed({ ...snapshot(), presentation: 'docked', paused: true, phase: 'paused', resumePosition: 42 }))
  assert.equal(button('恢复展开').props.disabled, false)
  await act(async () => button('恢复展开').props.onClick())
  assert.deepEqual(controls, [{ id: 'first', command: { kind: 'presentation', value: 'expanded' } }])
})

test('fullscreen mouse hover reveals only its own edge, including while paused', async context => {
  let hide: (() => void) | undefined
  context.mock.method(window, 'setTimeout', (callback: () => void, ms: number) => { if (ms === 3000) hide = callback; return 1 })
  context.mock.method(window, 'clearTimeout', () => {})
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  await mount()
  const current = { ...snapshot(), presentation: 'fullscreen' as const, rendererFullscreenControls: true, fullscreenPointerY: 400 }
  const panel = () => renderer!.root.find(node => node.props['data-playback-session'] === 'first')
  await act(async () => changed(current))
  assert.equal(panel().props['data-controls-visible'], false)
  assert.equal(panel().props['data-header-visible'], false)
  await act(async () => changed({ ...current, fullscreenPointerY: 450, interactionSequence: 2 }))
  assert.equal(panel().props['data-controls-visible'], false, 'native motion in the middle cannot summon chrome')
  await act(async () => changed({ ...current, fullscreenPointerY: 8 }))
  assert.equal(panel().props['data-header-visible'], true)
  assert.equal(panel().props['data-controls-visible'], false)
  await act(async () => changed({ ...current, fullscreenPointerY: 780 }))
  assert.equal(panel().props['data-controls-visible'], true)
  assert.equal(panel().props['data-header-visible'], false)
  await act(async () => panel().props.onPointerMove({ clientY: 400 }))
  assert.equal(panel().props['data-controls-visible'], false, 'HTML motion obeys the same regions')
  await act(async () => changed({ ...current, paused: true, phase: 'paused' }))
  assert.equal(panel().props['data-controls-visible'], false, 'pause does not bypass hover activation')
  await act(async () => changed({ ...current, paused: true, phase: 'paused', fullscreenPointerY: 780 }))
  assert.equal(panel().props['data-controls-visible'], true)
  await act(async () => changed(current))
  await act(async () => { panel().props.onKeyDownCapture({ key: 'Tab' }); panel().props.onFocusCapture({ target: {} }) })
  await act(async () => hide!())
  assert.equal(panel().props['data-controls-visible'], true, 'keyboard focus keeps chrome reachable')
  await act(async () => changed({ ...current, nativeVideoFocused: true }))
  await act(async () => hide!())
  assert.equal(panel().props['data-controls-visible'], false, 'native focus overrides stale HTML focus')
  await act(async () => changed(current))
  await act(async () => panel().props.onPointerDownCapture())
  await act(async () => panel().props.onFocusCapture({ target: { closest: () => ({}) } }))
  assert.equal(panel().props['data-controls-visible'], true, 'an owned popup stays reachable')
  await act(async () => changed(current))
  await act(async () => panel().props.onPointerDownCapture())
  await options()
  assert.equal(panel().props['data-controls-visible'], true, 'settings keep their toolbar entry visible')
  assert.equal(panel().props['data-header-visible'], true, 'settings fill the reserved title bar region')
  await act(async () => button('关闭播放设置').props.onClick())
  assert.equal(panel().props['data-header-visible'], false, 'closing settings restores header hover activation')
  assert.equal(panel().props['data-controls-visible'], false, 'closing settings restores toolbar hover activation')
})

test('Windows popup clipping keeps the remaining video visible and restores its complete region', async context => {
  let poll = (): void => {}
  context.mock.method(window, 'setInterval', (callback: () => void) => { poll = callback; return 1 })
  context.mock.method(window, 'clearInterval', () => {})
  const video = { x: 10, y: 20, width: 100, height: 80, left: 10, top: 20, right: 110, bottom: 100 }
  const popup = { getBoundingClientRect: () => ({ left: 80, top: 70, right: 160, bottom: 140 }), checkVisibility: () => true }
  let surfaces: typeof popup[] = []
  context.mock.method(document, 'querySelectorAll', () => surfaces)
  await mount({ createNodeMock: element => element.type === 'button' && String(element.props['aria-label']).startsWith('视频画面')
    ? { getBoundingClientRect: () => video, closest: () => null } : null })
  await act(async () => changed({ ...snapshot(), rendererFullscreenControls: true }))
  await act(async () => poll())
  surfaces = [popup]
  await act(async () => poll())
  assert.equal(viewports.at(-1)!.visible, true)
  assert.deepEqual(viewports.at(-1)!.occlusions, [{ x: 80, y: 70, width: 30, height: 30 }])
  surfaces = []
  await act(async () => poll())
  assert.deepEqual(viewports.at(-1)!.occlusions, [])
  assert.deepEqual(controls, [])
})
