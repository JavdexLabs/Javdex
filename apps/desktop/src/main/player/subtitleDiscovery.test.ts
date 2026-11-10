import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { NativePlayback } from './nativePlayback'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import type { PlaybackSource } from './playbackSource'
import { createSubtitleDiscovery } from './subtitleDiscovery'

async function fixture() {
  // Match PlaybackSourceResolver: sources use real paths, including Windows
  // short temp names and macOS /var aliases.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-subtitle-discovery-')))
  const file = path.join(root, 'ABC.zh.srt')
  await fs.writeFile(file, 'subtitle')
  let playback: PlaybackSnapshot | null = { sessionId: 'one', source: 'local', phase: 'playing', tracks: [] } as unknown as PlaybackSnapshot
  const source = { mode: 'local', locator: path.join(root, 'ABC.mp4'), resumeKey: 'revision-1' } as PlaybackSource
  const added: Array<{ file: string; selected: boolean }> = []
  const selections: Array<number | null> = []
  const tracks: Array<{ id: number; type: string; 'external-filename': string }> = []
  let wait = async (): Promise<void> => {}
  const deps = { filename: path.join(root, 'choices.json'), native: { read: () => ({ 'track-list': JSON.stringify(tracks) }) } as NativePlayback,
    playback: () => playback, source: () => source, validate: async () => { await wait() },
    add: (_id: string, file: string, selected: boolean) => { added.push({ file, selected }); tracks.push({ id: tracks.length + 1, type: 'sub', 'external-filename': file }) },
    select: (_id: string, id: number | null) => { selections.push(id) } }
  let discovery = createSubtitleDiscovery(deps)
  return { root, file, source, added, selections, get discovery() { return discovery },
    stop: () => { playback = null },
    start: () => { playback = { sessionId: 'new', source: 'local', phase: 'playing', tracks: [] } as unknown as PlaybackSnapshot },
    tick: () => discovery.tick(playback), replace: () => { playback = { ...playback!, sessionId: 'two' } },
    wait: (fn: typeof wait) => { wait = fn },
    restart: async () => { await discovery.close(); tracks.length = 0; added.length = 0; selections.length = 0; discovery = createSubtitleDiscovery(deps) },
    cleanup: async () => { await discovery.close(); await fs.rm(root, { recursive: true, force: true }) } }
}

test('automatic discovery adds unselected tracks and restores explicitly disabled subtitles after restart', async () => {
  const f = await fixture()
  try {
    f.tick(); await f.discovery.refresh(); f.tick()
    assert.deepEqual(f.added, [{ file: f.file, selected: false }])
    assert.deepEqual(f.selections, [1])
    f.discovery.selected(null)
    await f.restart(); f.tick(); await f.discovery.refresh(); f.tick()
    assert.deepEqual(f.selections, [null])
  } finally { await f.cleanup() }
})

test('manual selection while discovery waits cannot be overwritten; refresh does not duplicate tracks', async () => {
  const f = await fixture()
  let release!: () => void
  const waiting = new Promise<void>(done => { release = done })
  f.wait(() => waiting)
  try {
    f.tick()
    f.discovery.selected(null)
    release(); await f.discovery.refresh(); f.tick()
    assert.equal(f.selections.length, 0)
    await f.discovery.refresh(); f.tick()
    assert.equal(f.selections.length, 0)
    assert.equal(f.added.length, 1)
  } finally { release(); await f.cleanup() }
})

test('late discovery never adds old subtitles to a replacement playback', async () => {
  const f = await fixture()
  let release!: () => void
  const waiting = new Promise<void>(done => { release = done })
  f.wait(() => waiting)
  try {
    f.tick(); f.replace(); release(); await f.discovery.refresh()
    assert.equal(f.added.length, 0)
    assert.equal(f.selections.length, 0)
  } finally { release(); await f.cleanup() }
})

test('resource associations work without playback, survive restart and preserve explicit subtitle off', async () => {
  const f = await fixture()
  const linked = path.join(f.root, 'handpicked.ass')
  try {
    await fs.writeFile(linked, '[Script Info]')
    f.tick(); await f.discovery.refresh(); f.tick(); f.discovery.selected(null)
    f.stop()
    await f.discovery.associateFiles(f.source, [linked, linked])
    assert.equal(f.added.length, 1, 'management alone does not operate the player')
    await f.restart()
    const listed = await f.discovery.files(f.source)
    assert.equal(listed.error, null)
    assert.deepEqual(listed.files.map(file => [file.name, file.source, file.available]), [
      ['handpicked.ass', 'linked', true], ['ABC.zh.srt', 'directory', true]
    ])
    f.start(); f.tick(); await f.discovery.refresh(); f.tick()
    assert.deepEqual(new Set(f.added.map(item => item.file)), new Set([linked, f.file]))
    assert.deepEqual(f.selections, [null], 'adding an association cannot replace the saved off preference')
    await fs.rm(linked)
    const missing = (await f.discovery.files(f.source)).files.find(file => file.path === linked)
    assert.equal(missing?.available, false)
    assert.match(missing?.error ?? '', /文件不存在/)
  } finally { await f.cleanup() }
})

test('invalid or unauthorized associations never update the resource record', async () => {
  const f = await fixture()
  const linked = path.join(f.root, 'another.srt'), invalid = path.join(f.root, 'not-a-subtitle.txt')
  try {
    await fs.writeFile(linked, 'subtitle'); await fs.writeFile(invalid, 'text')
    await assert.rejects(f.discovery.associateFiles(f.source, [linked, invalid]), /SRT \/ ASS/)
    assert.equal((await f.discovery.files(f.source)).files.length, 1)
    f.wait(async () => { throw new Error('resource changed') })
    await assert.rejects(f.discovery.associateFiles(f.source, [linked]), /resource changed/)
    f.wait(async () => {})
    assert.equal((await f.discovery.files(f.source)).files.length, 1)
    await assert.rejects(f.discovery.associateFiles({ ...f.source, mode: 'remote' }, [linked]), /本机资源/)
  } finally { await f.cleanup() }
})

test('corrupt association storage remains readable as a warning but cannot report an added file as saved', async () => {
  const f = await fixture()
  const linked = path.join(f.root, 'manual.srt')
  try {
    await f.discovery.close()
    await fs.writeFile(path.join(f.root, 'choices.json'), 'corrupt')
    await fs.writeFile(linked, 'subtitle')
    await f.restart()
    assert.match((await f.discovery.files(f.source)).error ?? '', /原文件已保留/)
    await assert.rejects(f.discovery.associateFiles(f.source, [linked]), /无法读取/)
    assert.equal(await fs.readFile(path.join(f.root, 'choices.json'), 'utf8'), 'corrupt')
  } finally { await f.cleanup() }
})
