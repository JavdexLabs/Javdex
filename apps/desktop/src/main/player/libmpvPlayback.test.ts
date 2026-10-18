import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { NativePlaybackState } from './nativePlayback'
import type { PlaybackOcclusion, PlaybackSnapshot } from '@shared/desktop/playback'

// Exercise the production wrapper with isolated import adapters, without loading
// Electron or a native binary, changing process.platform, or adding a production seam.
const wrapperCode = transpileModule(readFileSync(new URL('./libmpvPlayback.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
const subtitleFile = path.resolve('fixture-subtitles', 'AI 日中字幕.ass')
const newSubtitleFile = path.resolve('fixture-subtitles', 'new.ass')

function fixture(platform: 'darwin' | 'win32' | 'linux') {
  const commands: string[][] = []
  let actions: NonNullable<NativePlaybackState['actions']> = []
  let created = false
  let rendererControls = false
  const viewports: unknown[] = [], occlusions: PlaybackOcclusion[][] = []
  let pending = 0, replies = 0, errors = 2, generatedErrors = 0, held = false
  let generatedPending = 0, generatedReplies = 0
  let overlayRevision = 0
  const overlays: Array<{ operation: string; document: string; visible: boolean; revision: number }> = []
  let sid = '7', aid = '2'
  const waiting: Array<{ args: string[]; generated: boolean }> = []
  let frozen: NativePlaybackState | null = null
  const tracks: Array<Record<string, unknown>> = [
    { id: 2, type: 'audio', selected: true, 'ff-index': 1 },
    { id: 4, type: 'audio', selected: false, 'ff-index': 2 },
    { id: 3, type: 'sub', selected: false },
    { id: 7, type: 'sub', selected: true, 'external-filename': subtitleFile }
  ]
  const snapshot = (): NativePlaybackState => ({ alive: created, rendererFullscreenControls: rendererControls, subtitleCommandErrors: errors,
    generatedSubtitleCommandErrors: generatedErrors,
    generatedSubtitleCommandsPending: generatedPending, generatedSubtitleCommandReplies: generatedReplies,
    generatedSubtitleOverlayVersion: 1, generatedSubtitleRevision: overlayRevision,
    subtitleCommandsPending: pending, subtitleCommandReplies: replies, sid, aid, 'track-list': JSON.stringify(tracks) })
  const complete = (args: string[], generated: boolean, failed = false): void => {
    pending--; replies++
    if (generated) { generatedPending--; generatedReplies++ }
    if (args[0] === 'overlay') overlayRevision = Number(args[4])
    if (failed) { errors++; if (generated) generatedErrors++; return }
    if (args[0] === 'sub-add') tracks.push({ id: 8, type: 'sub', selected: args[2] === 'select', 'external-filename': args[1] })
    if (args[0] === 'sub-remove') tracks.splice(tracks.findIndex(track => String(track.id) === args[1]), 1)
    if (args[0] === 'set' && args[1] === 'sid') sid = args[2]
  }
  const bridge = {
    create() { created = true },
    setRendererControls(value: boolean) { rendererControls = value },
    setBounds(bounds: unknown) { viewports.push(bounds) },
    setVisible() {},
    setPresentation() {},
    setOcclusions(rects: PlaybackOcclusion[]) { occlusions.push(rects) },
    command(args: string[], generated = false) {
      commands.push([...args])
      if (args[0].startsWith('sub-') || args[0] === 'set' && ['sid', 'sub-delay', 'sub-font-size'].includes(args[1])) {
        pending++
        if (generated) generatedPending++
        if (held) waiting.push({ args, generated })
        else complete(args, generated)
      }
    },
    inspect: () => frozen ?? snapshot(),
    generatedSubtitles(operation: string, document: string, visible: boolean, revision: number) {
      overlays.push({ operation, document, visible, revision })
      const args = ['overlay', operation, document, String(visible), String(revision)]
      pending++; generatedPending++
      if (held) waiting.push({ args, generated: true }); else complete(args, true)
    },
    state(): NativePlaybackState {
      const pending = actions
      actions = []
      return { ...snapshot(), actions: pending }
    },
    destroy() { created = false }
  }
  const moduleExports = {} as Pick<typeof import('./libmpvPlayback'), 'createLibmpvPlayback'>
  runInNewContext(wrapperCode, {
    exports: moduleExports,
    Buffer,
    process: { platform, resourcesPath: path.resolve('fixture-resources'), env: { DISPLAY: ':fixture' } },
    require(id: string): unknown {
      switch (id) {
        case 'electron': return {
          app: { isPackaged: false, getAppPath: () => path.resolve('fixture-app') },
          screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) }
        }
        case 'node:fs': return { existsSync: () => true }
        case 'node:path': return path
        case 'node:timers/promises': return { setTimeout: delay }
        case 'node:module': return { createRequire: () => () => bridge }
        case './playbackDisplay': return { linuxPlaybackBackend: () => 'x11' }
        case './linuxPlaybackBridge': return { createLinuxPlaybackBridge: () => bridge }
        case './linuxSharedTexture': return { createLinuxSharedTexture: () => { throw new Error('Legacy test must not initialize a shared-texture importer') } }
        default: throw new Error(`Unexpected playback wrapper dependency: ${id}`)
      }
    }
  }, { filename: 'libmpvPlayback.ts' })
  const window = {
    isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.alloc(4),
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    webContents: { getZoomFactor: () => 1 }
  } as unknown as BrowserWindow
  const native = moduleExports.createLibmpvPlayback(() => window)
  native.create()
  assert.equal(created, true, 'the real wrapper must load the fixture bridge')
  return { native, commands, overlays, viewports, occlusions, queue: (pending: typeof actions): void => { actions.push(...pending) },
    hold: (): void => { held = true },
    observeSelection: (sub: string, audio = aid): void => { sid = sub; aid = audio },
    freeze: (): void => { frozen = snapshot() }, thaw: (): void => { frozen = null },
    complete: (failed = false): void => { const value = waiting.shift(); assert.ok(value); complete(value.args, value.generated, failed) },
    release: (): void => { held = false; for (const value of waiting.splice(0)) complete(value.args, value.generated) } }
}

test('Linux and Windows enable the shared accessible fullscreen controls and pass popup cutouts', t => {
  for (const platform of ['linux', 'win32'] as const) {
    const f = fixture(platform)
    t.after(() => f.native.destroy())
    assert.equal(f.native.read().rendererFullscreenControls, true, `${platform} must enable the existing renderer controls`)
    const area: PlaybackOcclusion = { x: 20, y: 25, width: 180, height: 90, radii: [8, 8, 0, 0] }
    f.native.viewport({ x: 10, y: 12, width: 640, height: 360 }, true,
      { presentation: 'fullscreen' } as PlaybackSnapshot, [area])
    assert.deepEqual(JSON.parse(JSON.stringify(f.occlusions)), [[area]], 'the native surface must expose renderer popup geometry')
    assert.deepEqual(JSON.parse(JSON.stringify(f.viewports)), [{ x: 10, y: 12, width: 640, height: 360, scale: 1 }])
  }
})

const timeline = 'generated timeline fixture'
for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`${platform}: persistent AI display keeps virtual selection, manual ownership and native input`, async t => {
    const f = fixture(platform)
    t.after(() => f.native.destroy())
    const pending: NonNullable<NativePlaybackState['actions']> = [{ kind: 'history-back' }, { kind: 'toggle-pause' }]
    f.queue(pending)
    await f.native.updateGeneratedSubtitle!(subtitleFile, true, undefined, timeline)
    assert.equal(f.native.generatedSubtitleSelected!(subtitleFile), true)
    await f.native.updateGeneratedSubtitle!(subtitleFile, false, undefined, timeline + ' future cues')
    assert.deepEqual(f.commands, [['set', 'sid', 'no']], 'future results never reload or recreate tracks')
    assert.equal(f.overlays.at(-1)!.visible, true)
    const state = f.native.read()
    assert.deepEqual(state.actions, pending)
    assert.deepEqual(f.native.read().actions, [])
    const virtual = JSON.parse(state['track-list']!).find((track: { title: string }) => track.title === 'AI 日中字幕')
    assert.equal(virtual.id, Number.MAX_SAFE_INTEGER)
    f.native.command({ kind: 'track', type: 'sub', id: 3 })
    assert.equal(f.native.generatedSubtitleSelected!(subtitleFile), false)
    assert.equal(f.overlays.at(-1)!.visible, false)
    f.native.command({ kind: 'track', type: 'sub', id: virtual.id })
    assert.equal(f.native.generatedSubtitleSelected!(subtitleFile), true)
    assert.deepEqual(f.commands.at(-1), ['set', 'sid', 'no'])
    await f.native.removeGeneratedSubtitle!(subtitleFile, 3)
    assert.deepEqual(f.commands.at(-1), ['set', 'sid', '3'])
    assert.equal(f.overlays.at(-1)!.operation, 'clear')
    assert.equal(f.native.selectedAudioStream!(), 1)
  })
}

test('cancelling startup waits for the pending native operation and restores the original subtitle', async t => {
  const f = fixture('win32')
  t.after(() => f.native.destroy())
  f.hold()
  const controller = new AbortController()
  const update = f.native.updateGeneratedSubtitle!(subtitleFile, true, controller.signal, timeline)
  const rejected = assert.rejects(Promise.resolve(update), { name: 'AbortError' })
  await delay(5)
  controller.abort(); f.release(); f.observeSelection('7') // the command reply can precede its sid observation
  await rejected
  await f.native.removeGeneratedSubtitle!(subtitleFile, 3)
  assert.deepEqual(f.commands, [['set', 'sid', 'no'], ['set', 'sid', '3']])
})

test('overlay errors reject only optional subtitle display and preserve video playback', async t => {
  const f = fixture('win32')
  t.after(() => f.native.destroy())
  f.hold()
  const update = f.native.updateGeneratedSubtitle!(subtitleFile, false, undefined, timeline)
  const rejected = assert.rejects(Promise.resolve(update), /播放器未能更新 AI 字幕显示/)
  await delay(5); f.complete(true)
  await rejected
  assert.equal(f.native.read().alive, true)
})

test('Linux snapshots cannot acknowledge an overlay until its explicit revision arrives', async t => {
  const f = fixture('linux')
  t.after(() => f.native.destroy())
  f.hold(); f.freeze()
  let settled = false
  const update = Promise.resolve(f.native.updateGeneratedSubtitle!(subtitleFile, false, undefined, timeline)).then(() => { settled = true })
  await delay(25)
  f.complete()
  await delay(25)
  assert.equal(settled, false)
  f.thaw(); await update
  assert.equal(settled, true)
})

test('a manual selection arriving during AI startup wins over automatic display', async t => {
  const f = fixture('win32')
  t.after(() => f.native.destroy())
  f.hold()
  const update = f.native.updateGeneratedSubtitle!(newSubtitleFile, true, undefined, timeline)
  await delay(5)
  f.native.command({ kind: 'track', type: 'sub', id: 3 })
  f.release(); await update
  assert.equal(f.overlays.at(-1)!.visible, false)
  assert.equal(f.native.generatedSubtitleSelected!(newSubtitleFile), false)
  await f.native.removeGeneratedSubtitle!(newSubtitleFile, 7)
  assert.deepEqual(f.commands.at(-1), ['set', 'sid', '3'], 'stop must not override the manual selection')
})

test('cached native selection flags cannot override sid or aid observations', t => {
  const f = fixture('win32')
  t.after(() => f.native.destroy())
  f.observeSelection('no', '4')
  assert.equal(f.native.generatedSubtitleSelected!(subtitleFile), false)
  assert.equal(f.native.selectedAudioStream!(), 2)
  const tracks = JSON.parse(f.native.read()['track-list']!) as Array<{ type: string; id: number; selected: boolean }>
  assert.equal(tracks.some(track => track.type === 'sub' && track.selected), false)
  assert.equal(tracks.find(track => track.type === 'audio' && track.selected)?.id, 4)
})
