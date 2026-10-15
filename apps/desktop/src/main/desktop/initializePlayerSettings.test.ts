import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DefaultPlayerDetectionResult } from '@shared/desktop/settings'
import { initializePlayerSettings } from './initializePlayerSettings'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from './thisComputerSettingsStore'

const roots: string[] = []
function settingsStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-initialize-player-'))
  roots.push(root)
  const file = thisComputerSettingsPath(root)
  return { file, store: createThisComputerSettingsStore(file) }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('persists the detected program without changing playback mode or resume defaults', async () => {
  const { file, store } = settingsStore()
  let calls = 0
  const detect = async (): Promise<DefaultPlayerDetectionResult> => {
    calls++
    return { status: 'found', path: 'D:\\播放器 软件\\Player.exe', extension: '.mp4' }
  }
  await initializePlayerSettings(store, detect)
  const saved = await createThisComputerSettingsStore(file).read()
  assert.equal(saved.playerPath, 'D:\\播放器 软件\\Player.exe')
  assert.equal(saved.playerPreference, 'builtin')
  assert.equal(saved.resumePlayback, true)
  await initializePlayerSettings(createThisComputerSettingsStore(file), detect)
  assert.equal(calls, 1, 'a configured program is not replaced on subsequent startups')
})

it('keeps an existing program and playback preferences without querying associations', async () => {
  const { store } = settingsStore()
  await store.write({ playerPath: '/usr/bin/mpv', playerPreference: 'external', resumePlayback: false })
  let calls = 0
  await initializePlayerSettings(store, async () => {
    calls++
    return { status: 'found', path: '/usr/bin/other-player', extension: '.mp4' }
  })
  assert.equal(calls, 0)
  const saved = await store.read()
  assert.equal(saved.playerPath, '/usr/bin/mpv')
  assert.equal(saved.playerPreference, 'external')
  assert.equal(saved.resumePlayback, false)
})

it('fills an existing empty path without replacing unrelated settings', async () => {
  const { store } = settingsStore()
  await store.write({ mode: 'remote', remoteBaseUrl: 'https://library.example:8096', playerPath: null, resumePlayback: false })
  await initializePlayerSettings(store, async () => ({ status: 'found', path: '/usr/bin/mpv', extension: '.mkv' }))
  const saved = await store.read()
  assert.equal(saved.playerPath, '/usr/bin/mpv')
  assert.equal(saved.mode, 'remote')
  assert.equal(saved.remoteBaseUrl, 'https://library.example:8096')
  assert.equal(saved.resumePlayback, false)
})

it('leaves the path empty after failed detection and retries on a later startup', async () => {
  const { store } = settingsStore()
  for (const detect of [
    async (): Promise<DefaultPlayerDetectionResult> => ({ status: 'unavailable', message: 'No association' }),
    async (): Promise<DefaultPlayerDetectionResult> => { throw new Error('Association query failed') }
  ]) {
    await initializePlayerSettings(store, detect)
    assert.equal((await store.read()).playerPath, null)
  }
  await initializePlayerSettings(store, async () => ({ status: 'found', path: '/usr/bin/mpv', extension: '.mp4' }))
  assert.equal((await store.read()).playerPath, '/usr/bin/mpv')
})

it('preserves a program chosen while association detection was pending', async () => {
  const { store } = settingsStore()
  await initializePlayerSettings(store, async () => {
    await store.write({ playerPath: '/usr/bin/chosen-player', resumePlayback: false })
    return { status: 'found', path: '/usr/bin/system-player', extension: '.mp4' }
  })
  assert.equal((await store.read()).playerPath, '/usr/bin/chosen-player')
  assert.equal((await store.read()).resumePlayback, false)
})
