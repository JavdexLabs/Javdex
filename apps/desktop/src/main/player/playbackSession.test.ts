import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlaybackControl, PlaybackSnapshot, PlaybackTarget } from '@shared/desktop/playback'
import { createPlaybackSession } from './playbackSession'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
import type { PlaybackSource } from './playbackSource'
import { playbackControlSchema, playbackViewportSchema } from './playbackSchemas'

const target: PlaybackTarget = { libraryId: 1, videoId: 2, resourceId: 3 }
function fixture(volume?: { read(): Promise<number>; remember(value: number): void }, progress?: Parameters<typeof createPlaybackSession>[0]['progress']) {
  const events: Array<PlaybackSnapshot | null> = []
  const loads: string[] = []
  const loadOptions: Array<{ paused: boolean } | undefined> = []
  const commands: PlaybackControl[] = []
  const viewports: Array<{ visible: boolean; width: number }> = []
  const presentations: string[] = []
  const awake: boolean[] = []
  const navigations: string[] = []
  let starts = 0
  let resolves = 0
  let destroys = 0
  let focuses = 0
  let time = 1000000
  let raw: NativePlaybackState = { alive: true, loadedFiles: 1, pause: false, seekable: true, duration: 120, 'time-pos': 0, presentedFrames: 0 }
  const native: NativePlayback = {
    create() {}, load: (locator, options) => { loads.push(locator); loadOptions.push(options); raw.pause = options?.paused ?? false }, command: value => { commands.push(value) },
    read: () => raw, viewport: (rect, visible) => { viewports.push({ visible, width: rect.width }) },
    render() {}, addSubtitle() {}, destroy: () => { destroys++ }
  }
  let resolve = async (input: PlaybackTarget): Promise<PlaybackSource> => ({ target: input, title: 'Synthetic', mode: 'remote',
    locator: 'https://server.invalid/play?token=private', identityKey: 'catalog', revision: 'revision', resumeKey: 'resume-key' })
  let validate = async (_source: PlaybackSource): Promise<void> => {}
  const session = createPlaybackSession({ native,
    resolve: input => { resolves++; return resolve(input) }, validate: source => validate(source),
    changed: state => events.push(state), presentation: value => { presentations.push(value) }, started: async () => { starts++ }, awake: value => { awake.push(value) },
    windowSize: () => ({ width: 1000, height: 700 }),
    focusControls: () => { focuses++ },
    navigate: direction => { navigations.push(direction) },
    readVolume: volume?.read, volumeChanged: volume?.remember, progress, now: () => time
  })
  return { session, native, loads, loadOptions, commands, events, viewports, presentations, awake, navigations, advance: (ms: number) => { time += ms }, starts: () => starts, resolves: () => resolves, destroys: () => destroys, focuses: () => focuses,
    raw: (patch: Partial<NativePlaybackState>) => { raw = { ...raw, ...patch } },
    resolve: (next: typeof resolve) => { resolve = next }, validate: (next: typeof validate) => { validate = next } }
}
test('track projection retains bounded container channel hints and never external filenames', async () => {
  const f = fixture()
  await f.session.open(target)
  f.raw({ 'track-list': JSON.stringify([
    { id: 1, type: 'audio', title: 'Main', lang: 'eng', codec: 'aac', 'demux-channel-count': 2, selected: true },
    { id: 2, type: 'audio', title: 'Dub', lang: 'jpn', codec: 'ac3', 'demux-channel-count': 6 },
    ...[0, -1, 2.5, 1000000, '6', null].map((count, index) => ({ id: index + 3, type: 'audio', 'demux-channel-count': count })),
    { id: 1, type: 'sub', codec: 'ass', 'demux-channel-count': 2, 'external-filename': '/private/subtitle.ass' }
  ]) })
  f.session.tick()
  const state = f.session.snapshot()!
  assert.deepEqual(state.tracks.map(track => track.channelCountHint),
    [2, 6, null, null, null, null, null, null, null])
  assert.equal(JSON.stringify(state).includes('/private/subtitle.ass'), false)
})

test('paused PGS refresh waits for selection feedback and keeps the intended position rather than the reinit clock', async () => {
  const f = fixture()
  await f.session.open(target)
  const id = f.session.snapshot()!.sessionId
  f.raw({ pause: true, 'time-pos': 12, 'track-list': JSON.stringify([{ id: 1, type: 'sub', codec: 'hdmv_pgs_subtitle', selected: false }]) })
  f.session.tick()
  const before = f.commands.length
  f.session.control(id, { kind: 'track', type: 'sub', id: 1 })
  assert.deepEqual(f.commands.slice(before), [{ kind: 'track', type: 'sub', id: 1 }], 'do not race a seek against decoder selection')
  assert.equal(f.session.snapshot()!.paused, true)
  assert.equal(f.session.snapshot()!.seeking, true)
  f.session.tick()
  assert.deepEqual(f.commands.slice(before), [{ kind: 'track', type: 'sub', id: 1 }], 'old track feedback must not dispatch a refresh')
  f.raw({ 'time-pos': 10.417, 'track-list': JSON.stringify([{ id: 1, type: 'sub', codec: 'hdmv_pgs_subtitle', selected: true }]) })
  f.session.tick()
  assert.deepEqual(f.commands.slice(before), [{ kind: 'track', type: 'sub', id: 1 }, { kind: 'seek', seconds: 12 }])
  f.raw({ 'time-pos': 12 }); f.session.tick()
  assert.equal(f.session.snapshot()!.seeking, false)
  assert.equal(f.loads.length, 1)
  assert.equal(f.session.snapshot()!.sessionId, id)
  f.raw({ 'track-list': JSON.stringify([{ id: 1, type: 'sub', codec: 'hdmv_pgs_subtitle', selected: false }]) }); f.session.tick()
  const pending = f.commands.length
  f.session.control(id, { kind: 'track', type: 'sub', id: 1 })
  f.session.control(id, { kind: 'seek', seconds: 19 })
  f.raw({ 'track-list': JSON.stringify([{ id: 1, type: 'sub', codec: 'hdmv_pgs_subtitle', selected: true }]) }); f.session.tick()
  assert.deepEqual(f.commands.slice(pending), [{ kind: 'track', type: 'sub', id: 1 }, { kind: 'seek', seconds: 19 }, { kind: 'seek', seconds: 19 }],
    'PGS refresh must not jump back to an old projected clock during an in-flight seek')
})

test('deferred PGS refresh is canceled by a newer track request, play, stop or source replacement', async () => {
  for (const action of ['off', 'text', 'play', 'stop', 'replace'] as const) {
    const f = fixture()
    await f.session.open(target)
    const id = f.session.snapshot()!.sessionId
    f.raw({ pause: true, 'time-pos': 4, 'track-list': JSON.stringify([
      { id: 1, type: 'sub', codec: 'hdmv_pgs_subtitle', selected: false }, { id: 2, type: 'sub', codec: 'ass', selected: false }
    ]) }); f.session.tick()
    f.session.control(id, { kind: 'track', type: 'sub', id: 1 })
    if (action === 'off' || action === 'text') f.session.control(id, { kind: 'track', type: 'sub', id: action === 'off' ? null : 2 })
    else if (action === 'play') { f.session.control(id, { kind: 'pause', paused: false }); f.raw({ pause: false }) }
    else if (action === 'stop') f.session.stop()
    else await f.session.open({ ...target, resourceId: 4 })
    const count = f.commands.length
    f.raw({ 'track-list': JSON.stringify([{ id: 1, type: 'sub', codec: 'hdmv_pgs_subtitle', selected: true }]) }); f.session.tick()
    assert.equal(f.commands.length, count, action)
    assert.equal(f.commands.some(command => command.kind === 'seek'), false, action)
  }
})

test('missing PGS selection feedback has a bounded failure rather than saving a reinit clock or retrying forever', async () => {
  const f = progressFixture()
  await f.session.open(target); f.start(40)
  f.raw({ pause: true, 'time-pos': 42, 'track-list': JSON.stringify([{ id: 1, type: 'sub', codec: 'hdmv_pgs_subtitle', selected: false }]) })
  f.session.tick()
  const count = f.saves.length
  f.session.control(f.session.snapshot()!.sessionId, { kind: 'track', type: 'sub', id: 1 })
  f.raw({ 'time-pos': 10.417 }); f.advance(19999); f.session.tick()
  assert.equal(f.session.snapshot()!.seeking, true)
  assert.equal(f.saves.length, count, 'selection reinit is not progress')
  f.advance(1); f.session.tick()
  assert.equal(f.session.snapshot()!.phase, 'error')
  assert.equal(f.session.snapshot()!.seeking, false)
  assert.match(f.session.snapshot()!.error!, /20 秒/)
  const commands = f.commands.length
  f.advance(20000); f.session.tick()
  assert.equal(f.commands.length, commands)
})

test('PGS refresh does not seek for playing, disabled/already-selected, unseekable, unknown-time or resume-choice sessions', async () => {
  for (const scenario of ['playing', 'off', 'selected', 'unseekable', 'unknown', 'text', 'audio', 'ended', 'resume'] as const) {
    const progress = scenario === 'resume' ? { prepare: async () => ({ enabled: true, point: { position: 60, duration: 120 } }),
      save: () => {}, clear: () => {} } : undefined
    const f = fixture(undefined, progress)
    await f.session.open(target)
    const id = f.session.snapshot()!.sessionId
    const type = scenario === 'audio' ? 'audio' : 'sub'
    f.raw({ pause: scenario !== 'playing', 'time-pos': scenario === 'unknown' ? undefined : 12,
      seekable: scenario !== 'unseekable', 'eof-reached': scenario === 'ended',
      'track-list': JSON.stringify([{ id: 1, type, codec: scenario === 'text' ? 'ass' : 'hdmv_pgs_subtitle', selected: scenario === 'selected' }]) })
    f.session.tick()
    const before = f.commands.length
    const command: PlaybackControl = { kind: 'track', type, id: scenario === 'off' ? null : 1 }
    f.session.control(id, command)
    assert.deepEqual(f.commands.slice(before), [command], scenario)
  }
})
test('native end-of-file play restarts the same session and consecutive toggles retain ordering', async () => {
  const f = fixture()
  await f.session.open(target)
  const id = f.session.snapshot()!.sessionId
  f.raw({ pause: true, 'eof-reached': true, 'time-pos': 120, actions: [{ kind: 'toggle-pause' }] })
  f.session.tick()
  assert.deepEqual(f.commands.slice(-2), [{ kind: 'seek', seconds: 0 }, { kind: 'pause', paused: false }])
  assert.equal(f.session.snapshot()!.sessionId, id)
  assert.equal(f.loads.length, 1)
  f.raw({ pause: false, seeking: false, 'eof-reached': false, 'time-pos': 0,
    actions: [{ kind: 'toggle-pause' }, { kind: 'toggle-pause' }, { kind: 'toggle-mute' }, { kind: 'toggle-mute' }] })
  f.session.tick()
  assert.deepEqual(f.commands.slice(-4), [{ kind: 'pause', paused: true }, { kind: 'pause', paused: false },
    { kind: 'mute', muted: true }, { kind: 'mute', muted: false }])
})

test('native Tab hands focus to HTML without sending transport commands or rebuilding playback', async () => {
  const f = fixture()
  await f.session.open(target)
  const id = f.session.snapshot()!.sessionId
  f.raw({ actions: [{ kind: 'focus-forward' }] }); f.session.tick()
  assert.deepEqual(f.session.snapshot()!.focusRequest, { sequence: 1, backwards: false })
  f.raw({ actions: [{ kind: 'focus-backward' }] }); f.session.tick()
  assert.deepEqual(f.session.snapshot()!.focusRequest, { sequence: 2, backwards: true })
  assert.equal(f.focuses(), 2)
  assert.equal(f.session.snapshot()!.sessionId, id)
  assert.equal(f.loads.length, 1)
  assert.equal(f.commands.length, 1, 'only initial volume command')
  assert.equal(playbackControlSchema.safeParse({ kind: 'focus-forward' }).success, false, 'renderer cannot forge native focus actions')
})
test('native history input goes through the window coordinator without pretending to be a transport command', async () => {
  const f = fixture()
  await f.session.open(target)
  const id = f.session.snapshot()!.sessionId
  f.raw({ actions: [{ kind: 'history-back' }, { kind: 'history-forward' }] }); f.session.tick()
  assert.deepEqual(f.navigations, ['back', 'forward'])
  assert.equal(f.session.snapshot()!.sessionId, id)
  assert.equal(f.commands.length, 1)
  assert.equal(f.loads.length, 1)
  assert.equal(playbackControlSchema.safeParse({ kind: 'history-back' }).success, false)
})

test('stop and failure restore HTML focus when releasing native playback', async () => {
  const f = fixture()
  await f.session.open(target)
  f.session.control(f.session.snapshot()!.sessionId, { kind: 'presentation', value: 'fullscreen' })
  f.session.stop()
  assert.equal(f.focuses(), 1)
  assert.equal(f.session.snapshot(), null)
  assert.deepEqual(f.presentations.slice(-2), ['fullscreen', 'expanded'])
  const g = fixture()
  await g.session.open(target)
  g.session.control(g.session.snapshot()!.sessionId, { kind: 'presentation', value: 'fullscreen' })
  g.raw({ error: 'untrusted native error', errorKind: 'format' }); g.session.tick()
  assert.equal(g.focuses(), 1)
  assert.equal(g.session.snapshot()!.phase, 'error')
  assert.equal(g.session.snapshot()!.presentation, 'expanded')
})
test('saved volume applies before playback; HTML and native controls remember only explicit volume changes', async () => {
  const remembered: number[] = []
  const f = fixture({ read: async () => 23, remember: value => remembered.push(value) })
  await f.session.open(target)
  assert.deepEqual(f.commands[0], { kind: 'volume', value: 23 })
  assert.equal(f.session.snapshot()!.volume, 23)
  f.raw({ volume: 23 }); f.session.tick()
  assert.deepEqual(remembered, [])
  f.session.control(f.session.snapshot()!.sessionId, { kind: 'volume', value: 0 })
  f.raw({ actions: [{ kind: 'volume', value: 67 }] }); f.session.tick()
  assert.deepEqual(remembered, [0, 67])
  await f.session.open(target)
  assert.equal(f.commands.filter(command => command.kind === 'volume').length, 3, 'same source does not reapply saved volume')
})

test('native slider key repeats accumulate against session intent and retain volume bounds', async () => {
  const remembered: number[] = []
  const f = fixture({ read: async () => 31, remember: value => remembered.push(value) })
  await f.session.open(target)
  f.raw({ volume: 31, pause: true, 'time-pos': 40, actions: [
    ...Array.from({ length: 10 }, () => ({ kind: 'volume-relative' as const, value: 1 })),
    { kind: 'seek-relative', value: 30 }, { kind: 'seek-relative', value: 5 }
  ] })
  f.session.tick()
  assert.deepEqual(remembered, Array.from({ length: 10 }, (_, index) => 32 + index))
  assert.deepEqual(f.commands.slice(-2), [{ kind: 'seek', seconds: 70 }, { kind: 'seek', seconds: 75 }])
  assert.equal(f.session.snapshot()!.paused, true)
  f.raw({ volume: 41, actions: [{ kind: 'volume', value: 99 }, { kind: 'volume-relative', value: 5 },
    { kind: 'volume', value: 0 }, { kind: 'volume-relative', value: -1 }] })
  f.session.tick()
  assert.deepEqual(remembered.slice(-4), [99, 100, 0, 0])
  assert.equal(f.loads.length, 1)
  assert.equal(playbackControlSchema.safeParse({ kind: 'volume-relative', value: 1 }).success, false)
})

function progressFixture(point: { position: number; duration: number | null } | null = null) {
  const saves: Array<{ resourceId: number; point: typeof point }> = []
  const clears: number[] = []
  let preparations = 0
  const f = fixture(undefined, {
    prepare: async () => { preparations++; return { enabled: true, point } },
    save: (source, value) => saves.push({ resourceId: source.target.resourceId, point: value }),
    clear: source => { clears.push(source.target.resourceId) }
  })
  const start = (position = 40): void => {
    f.raw({ pause: false, seeking: false, 'time-pos': position, presentedFrames: 5 }); f.session.tick()
    f.raw({ pause: false, 'time-pos': position + 0.2, presentedFrames: 6 }); f.session.tick()
  }
  return { ...f, saves, clears, start, preparations: () => preparations }
}

test('a resume point loads paused and transport controls cannot bypass the explicit decision', async () => {
  const f = progressFixture({ position: 60, duration: 120 })
  await f.session.open(target)
  assert.deepEqual(f.loadOptions, [{ paused: true }])
  f.raw({ 'time-pos': 0, presentedFrames: 1 }); f.session.tick()
  const id = f.session.snapshot()!.sessionId
  f.session.control(id, { kind: 'pause', paused: false })
  f.session.control(id, { kind: 'seek', seconds: 30 })
  f.session.control(id, { kind: 'presentation', value: 'docked' })
  assert.equal(f.commands.length, 1, 'only initial volume was sent')
  assert.equal(f.session.snapshot()!.presentation, 'docked', 'waiting for a decision can collapse without starting playback')
  assert.equal(f.session.snapshot()!.resumePosition, 60)
  f.session.control(id, { kind: 'presentation', value: 'fullscreen' })
  assert.equal(f.session.snapshot()!.presentation, 'docked', 'fullscreen still cannot hide the resume decision')
  assert.equal(f.starts(), 0)
  assert.equal(f.saves.length, 0)
  f.session.control(id, { kind: 'resume', choice: 'continue' })
  assert.deepEqual(f.commands.slice(-2), [{ kind: 'seek', seconds: 60 }, { kind: 'pause', paused: false }])
  f.start(60)
  assert.equal(f.starts(), 1)
  assert.equal(f.session.snapshot()!.resumePosition, null)
  f.advance(10000); f.session.tick()
  assert.equal(f.saves[0].point?.position, 60.2)
})

test('private opening skips resume reads, writes and EOF clearing; stopping a waiting resume preserves the old point', async () => {
  const f = progressFixture({ position: 60, duration: 120 })
  await f.session.open(target, true)
  assert.equal(f.preparations(), 0)
  assert.deepEqual(f.loadOptions, [{ paused: false }])
  assert.equal(f.session.snapshot()!.recordingProgress, false)
  f.start(); f.advance(20000); f.session.tick()
  f.raw({ 'eof-reached': true, 'time-pos': 120 }); f.session.tick(); f.session.stop()
  assert.equal(f.saves.length, 0)
  assert.deepEqual(f.clears, [])
  await f.session.open(target)
  f.raw({ 'eof-reached': false, 'time-pos': 0 }); f.session.tick(); f.session.stop()
  assert.equal(f.preparations(), 1)
  assert.equal(f.saves.length, 0)
})

test('progress saves only after actual start, every ten seconds and on pause/stop; pending seeks cannot save stale positions', async () => {
  const f = progressFixture()
  await f.session.open(target)
  f.raw({ pause: true, 'time-pos': 60, presentedFrames: 2 }); f.session.tick()
  f.advance(15000); f.session.tick()
  assert.equal(f.saves.length, 0)
  f.start(40)
  assert.equal(f.saves.length, 1)
  f.raw({ 'time-pos': 41, presentedFrames: 7 }); f.advance(9000); f.session.tick()
  assert.equal(f.saves.length, 1)
  f.advance(1000); f.session.tick()
  assert.equal(f.saves.length, 2)
  f.raw({ 'time-pos': 42, presentedFrames: 8 }); f.session.tick()
  const id = f.session.snapshot()!.sessionId
  f.session.control(id, { kind: 'pause', paused: true })
  assert.equal(f.saves.at(-1)?.point?.position, 42)
  const count = f.saves.length
  f.session.control(id, { kind: 'seek', seconds: 80 })
  f.raw({ pause: true, seeking: false, 'time-pos': 42 }); f.advance(10000); f.session.tick()
  assert.equal(f.session.snapshot()!.seeking, true, 'old native observations do not complete the seek')
  assert.equal(f.saves.length, count)
  f.raw({ 'time-pos': 80 }); f.session.tick(); f.session.stop()
  assert.equal(f.saves.at(-1)?.point?.position, 80)
})

test('from-start decision, switching sources, EOF and live opt-out retain the correct resource identity', async () => {
  const f = progressFixture({ position: 60, duration: 120 })
  await f.session.open(target); f.session.tick()
  f.session.control(f.session.snapshot()!.sessionId, { kind: 'resume', choice: 'start' })
  assert.deepEqual(f.commands.slice(-2), [{ kind: 'seek', seconds: 0 }, { kind: 'pause', paused: false }])
  f.raw({ 'time-pos': 0, pause: false }); f.session.tick()
  f.start(40)
  await f.session.open({ ...target, resourceId: 4 })
  assert.equal(f.saves.at(-1)?.resourceId, 3)
  f.raw({ 'time-pos': 0 }); f.session.tick()
  f.session.control(f.session.snapshot()!.sessionId, { kind: 'resume', choice: 'continue' })
  f.start(60)
  f.raw({ 'eof-reached': true, 'time-pos': 120 }); f.session.tick()
  assert.deepEqual(f.saves.at(-1), { resourceId: 4, point: null })
  f.raw({ 'eof-reached': false })
  f.session.stop()
  await f.session.open(target)
  f.session.stopRecording()
  f.start(60); f.advance(20000); f.session.tick(); f.session.stop()
  assert.equal(f.saves.at(-1)?.resourceId, 4, 'global disable does not backfill or overwrite the previous point')
})

test('explicit progress clearing requires the current session and does not immediately recreate a point', async () => {
  const f = progressFixture()
  await f.session.open(target); f.start()
  const id = f.session.snapshot()!.sessionId
  assert.throws(() => f.session.clearProgress('old-session'), /会话/)
  f.session.clearProgress(id)
  assert.deepEqual(f.clears, [3])
  assert.equal(f.session.snapshot()!.recordingProgress, false)
  f.advance(20000); f.session.tick(); f.session.stop()
  assert.equal(f.saves.length, 0)
})

test('presentation changes and reopening the same resource preserve the single session without load or grant', async () => {
  const f = fixture()
  await f.session.open(target)
  const id = f.session.snapshot()!.sessionId
  for (const value of ['docked', 'expanded', 'fullscreen', 'docked'] as const) {
    f.session.control(id, { kind: 'presentation', value })
    assert.equal(f.session.snapshot()!.sessionId, id)
  }
  await f.session.open(target)
  assert.equal(f.session.snapshot()!.sessionId, id)
  assert.equal(f.session.snapshot()!.presentation, 'expanded')
  assert.equal(f.resolves(), 1)
  assert.equal(f.loads.length, 1)
  assert.equal(f.destroys(), 1)
  const geometryChanges = f.viewports.length
  await f.session.open(target)
  assert.equal(f.viewports.length, geometryChanges, 'reopening an expanded session must not hide its unchanged viewport')
  assert.ok(!JSON.stringify(f.events).includes('token=private'))
})
test('a late open cannot replace a newer source or resurrect a stopped player', async () => {
  const f = fixture()
  let finish!: (source: PlaybackSource) => void
  f.resolve(() => new Promise(resolve => { finish = resolve }))
  const opening = f.session.open(target)
  f.session.stop()
  finish({ target, title: 'old', mode: 'local', locator: '/private/old.mp4', identityKey: 'old', revision: 'old', resumeKey: 'old-key' })
  await opening
  assert.equal(f.session.snapshot(), null)
  assert.equal(f.loads.length, 0)
})
test('stale source controls and presentation geometry cannot cover the current UI', async () => {
  const f = fixture()
  await f.session.open(target)
  const id = f.session.snapshot()!.sessionId
  f.session.control(id, { kind: 'presentation', value: 'docked' })
  const baseline = f.viewports.length
  f.session.viewport({ sessionId: id, presentation: 'expanded', presentationRevision: 0, sequence: 20, rect: { x: 0, y: 0, width: 1000, height: 700 }, visible: true })
  assert.equal(f.viewports.length, baseline)
  f.session.viewport({ sessionId: id, presentation: 'docked', presentationRevision: 1, sequence: 21, rect: { x: 0, y: 580, width: 180, height: 100 }, visible: true })
  assert.deepEqual(f.viewports.at(-1), { visible: true, width: 180 })
  f.session.viewport({ sessionId: id, presentation: 'docked', presentationRevision: 1, sequence: 20, rect: { x: 0, y: 0, width: 1000, height: 700 }, visible: true })
  assert.deepEqual(f.viewports.at(-1), { visible: true, width: 180 })
  f.session.viewport({ sessionId: id, presentation: 'docked', presentationRevision: 1, sequence: 22, rect: { x: 900, y: 0, width: 1000, height: 700 }, visible: true })
  assert.equal(f.viewports.at(-1)!.visible, false)
  f.session.control(id, { kind: 'presentation', value: 'expanded' })
  const changed = f.viewports.length
  f.session.viewport({ sessionId: id, presentation: 'expanded', presentationRevision: 0, sequence: 99,
    rect: { x: 0, y: 0, width: 1000, height: 700 }, visible: true })
  assert.equal(f.viewports.length, changed, 'old geometry from the previous expanded presentation is rejected')
  f.session.stop()
  assert.throws(() => f.session.control(id, { kind: 'pause', paused: false }), /会话/)
})
test('actual-start requires advancing rendered video and clock; paused/seek-only frames do not qualify', async () => {
  const f = fixture()
  await f.session.open(target)
  const id = f.session.snapshot()!.sessionId
  f.raw({ pause: true, presentedFrames: 1, 'time-pos': 0 }); f.session.tick()
  f.raw({ pause: true, presentedFrames: 2, 'time-pos': 20 }); f.session.tick()
  assert.equal(f.starts(), 0)
  f.raw({ pause: false, presentedFrames: 3, 'time-pos': 20 }); f.session.tick()
  f.raw({ pause: false, presentedFrames: 4, 'time-pos': 20.2 }); f.session.tick()
  assert.equal(f.starts(), 1)
  f.session.control(id, { kind: 'presentation', value: 'docked' })
  f.raw({ presentedFrames: 5, 'time-pos': 20.4 }); f.session.tick()
  assert.equal(f.starts(), 1)
})
test('boundary schemas reject arbitrary commands, host paths, unknown keys and invalid geometry', () => {
  for (const command of [{ kind: 'loadfile', url: '/private/a' }, { kind: 'volume', value: 101 }, { kind: 'speed', value: 99 }, { kind: 'pause', paused: true, locator: 'http://x' }]) {
    assert.equal(playbackControlSchema.safeParse(command).success, false)
  }
  assert.equal(playbackViewportSchema.safeParse({ sessionId: 'wrong', sequence: 0, presentation: 'expanded', visible: true,
    rect: { x: 0, y: 0, width: Infinity, height: 700 } }).success, false)
})

test('subtitle state reflects native observations and seek preserves pause intent', async () => {
  const f = fixture()
  await f.session.open(target)
  const id = f.session.snapshot()!.sessionId
  assert.equal(f.session.snapshot()!.subtitleDelay, null)
  f.raw({ pause: true, 'sub-delay': 1.5, 'sub-font-size': 70,
    'track-list': JSON.stringify([{ id: 2, type: 'sub', codec: 'subrip', selected: true, 'external-filename': '/private/sub.srt' }]) })
  f.session.tick()
  assert.equal(f.session.snapshot()!.subtitleDelay, 1.5)
  assert.equal(f.session.snapshot()!.subtitleSize, 70)
  assert.equal(f.session.snapshot()!.tracks[0].codec, 'subrip')
  assert.ok(!JSON.stringify(f.session.snapshot()).includes('/private'))
  f.session.control(id, { kind: 'seek', seconds: 60 })
  assert.deepEqual(f.commands, [{ kind: 'volume', value: 50 }, { kind: 'seek', seconds: 60 }])
  assert.equal(f.session.snapshot()!.paused, true)
  for (const command of [{ kind: 'subtitle-delay', seconds: 61 }, { kind: 'subtitle-size', value: 101 }]) {
    assert.equal(playbackControlSchema.safeParse(command).success, false)
  }
})

test('native keyboard actions use the same seek and mute controls without changing pause intent', async () => {
  const f = fixture()
  await f.session.open(target)
  f.raw({ pause: true, mute: false, 'time-pos': 60, actions: [
    { kind: 'seek-relative', value: -5 }, { kind: 'seek-relative', value: 30 }, { kind: 'toggle-mute' }
  ] })
  f.session.tick()
  assert.deepEqual(f.commands, [
    { kind: 'volume', value: 50 },
    { kind: 'seek', seconds: 55 }, { kind: 'seek', seconds: 85 }, { kind: 'mute', muted: true }
  ])
  assert.equal(f.session.snapshot()!.paused, true)
  f.raw({ mute: true, actions: [{ kind: 'toggle-mute' }] })
  f.session.tick()
  assert.deepEqual(f.commands.at(-1), { kind: 'mute', muted: false })
  const commandCount = f.commands.length
  f.raw({ seekable: false, actions: [{ kind: 'seek-relative', value: 5 }] })
  f.session.tick()
  assert.equal(f.commands.length, commandCount, 'unseekable playback ignores the native seek shortcut')
})

test('opening and seek timeouts release the core, retain actionable errors and exit fullscreen', async () => {
  const f = fixture()
  await f.session.open(target)
  f.raw({ loadedFiles: 0 })
  f.advance(29999); f.session.tick()
  assert.equal(f.session.snapshot()!.phase, 'opening')
  f.advance(1); f.session.tick()
  const failed = f.session.snapshot()!
  assert.equal(failed.phase, 'error')
  assert.match(failed.error!, /30 秒/)
  assert.equal(f.awake.at(-1), false)
  const loads = f.loads.length
  f.advance(60000); f.session.tick()
  assert.equal(f.loads.length, loads, 'a timeout must not retry automatically')
  f.raw({ loadedFiles: 1, 'time-pos': 0 })
  await f.session.open(failed.target)
  const retried = f.session.snapshot()!
  assert.notEqual(retried.sessionId, failed.sessionId)
  assert.equal(f.resolves(), 2, 'explicit retry rechecks the same target')
  assert.deepEqual(retried.target, failed.target)
  f.session.tick()
  f.session.control(retried.sessionId, { kind: 'presentation', value: 'fullscreen' })
  f.session.control(retried.sessionId, { kind: 'seek', seconds: 80 })
  f.advance(20000); f.session.tick()
  assert.equal(f.session.snapshot()!.phase, 'error')
  assert.equal(f.session.snapshot()!.presentation, 'expanded')
  assert.equal(f.session.snapshot()!.seeking, false)
  assert.match(f.session.snapshot()!.error!, /20 秒/)
  assert.equal(f.presentations.at(-1), 'expanded')
})

test('native errors use controlled causes, never raw locators; initialization failure is not a successful open', async () => {
  const f = fixture()
  f.native.create = () => { throw new Error('dlopen /private/movie?token=secret') }
  await assert.rejects(f.session.open(target), /运行库无法初始化/)
  assert.equal(f.session.snapshot()!.phase, 'error')
  assert.ok(!JSON.stringify(f.events).includes('secret'))
  f.native.create = () => {}
  await f.session.open(target)
  f.raw({ error: 'https://server.invalid?token=secret', errorKind: 'format' }); f.session.tick()
  assert.match(f.session.snapshot()!.error!, /格式/)
  assert.ok(!JSON.stringify(f.events).includes('secret'))
})

test('an old source validation does not stop a new session or block its validation', async () => {
  const f = fixture()
  let rejectOld!: (error: Error) => void
  f.validate(() => new Promise((_, reject) => { rejectOld = reject }))
  await f.session.open(target)
  f.advance(5000); f.session.tick()
  let validations = 0
  f.validate(async () => { validations++ })
  await f.session.open({ ...target, resourceId: 4 })
  f.advance(5000); f.session.tick()
  assert.equal(validations, 1)
  rejectOld(new Error('/private/old-source'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.session.snapshot()!.target.resourceId, 4)
  assert.notEqual(f.session.snapshot()!.phase, 'error')
})
