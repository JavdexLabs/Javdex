import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import type { BrowserWindow } from 'electron'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'

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
  const snapshot = (): NativePlaybackState => ({ alive: created, subtitleCommandErrors: 2, 'track-list': JSON.stringify([
    { id: 2, type: 'audio', selected: true, 'ff-index': 1 },
    { id: 3, type: 'sub', selected: false },
    { id: 7, type: 'sub', selected: true, 'external-filename': subtitleFile }
  ]) })
  const bridge = {
    create() { created = true },
    setRendererControls() {},
    command(args: string[]) { commands.push([...args]) },
    inspect: snapshot,
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
        case 'node:module': return { createRequire: () => () => bridge }
        case './playbackDisplay': return { linuxPlaybackBackend: () => 'x11' }
        case './linuxPlaybackBridge': return { createLinuxPlaybackBridge: () => bridge }
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
  return { native, commands, queue: (pending: typeof actions): void => { actions.push(...pending) } }
}

const peeks: Array<{
  name: string
  run(native: NativePlayback): void
  commands: string[][]
}> = [
  { name: 'reload and select a generated subtitle', run: native => native.updateGeneratedSubtitle!(subtitleFile, true),
    commands: [['sub-reload', '7'], ['set', 'sid', '7']] },
  { name: 'reload without selecting a generated subtitle', run: native => native.updateGeneratedSubtitle!(subtitleFile, false),
    commands: [['sub-reload', '7']] },
  { name: 'add a generated subtitle not yet present', run: native => native.updateGeneratedSubtitle!(newSubtitleFile, true),
    commands: [['sub-add', newSubtitleFile, 'select', 'AI 日中字幕']] },
  { name: 'remove a generated subtitle and restore the prior track', run: native => native.removeGeneratedSubtitle!(subtitleFile, 3),
    commands: [['sub-remove', '7'], ['set', 'sid', '3']] },
  { name: 'remove a generated subtitle with no prior track', run: native => native.removeGeneratedSubtitle!(subtitleFile, null),
    commands: [['sub-remove', '7'], ['set', 'sid', 'no']] },
  { name: 'inspect generated subtitle selection', run: native => assert.equal(native.generatedSubtitleSelected!(subtitleFile), true),
    commands: [] },
  { name: 'inspect the selected audio stream', run: native => assert.equal(native.selectedAudioStream!(), 1),
    commands: [] },
  { name: 'inspect optional subtitle command failures', run: native => assert.equal(native.subtitleCommandErrors!(), 2),
    commands: [] }
]

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  for (const peek of peeks) {
    test(`${platform}: ${peek.name} leaves native actions for the session read`, t => {
      const { native, commands, queue } = fixture(platform)
      t.after(() => native.destroy())
      const pending: NonNullable<NativePlaybackState['actions']> = [
        { kind: 'toggle-pause' }, { kind: 'seek-relative', value: 5 }, { kind: 'history-back' }
      ]
      queue(pending)
      peek.run(native)
      assert.deepEqual(commands, peek.commands, 'track operations must still reach the bridge')
      assert.deepEqual(native.read().actions, pending, 'track inspection must not consume queued playback input')
      assert.deepEqual(native.read().actions, [], 'the session read must consume each action exactly once')
    })
  }
}
