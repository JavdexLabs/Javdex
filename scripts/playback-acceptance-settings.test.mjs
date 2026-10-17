import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../apps/desktop/src/main/desktop/thisComputerSettingsStore.ts'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'
import { assertOrdinaryAcceptanceExit } from './playback-acceptance-cleanup.mjs'

test('non-recording playback explicitly changes the real fresh default, not product policy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-settings-'))
  try {
    const store = createThisComputerSettingsStore(thisComputerSettingsPath(directory))
    const patches = []
    const api = { get: () => store.read(), update: async patch => {
      patches.push(patch)
      return { settings: await store.write(patch), restartRequired: false }
    } }
    const page = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})()`, { window: { api: { thisComputer: api } } }) }
    await prepareNonRecordingPlayback(page)
    assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ resumePlayback: false }])
    assert.equal((await store.read()).resumePlayback, false)
    assert.equal((await store.read()).playerPreference, 'builtin')
    const fresh = createThisComputerSettingsStore(path.join(directory, 'another-new-profile.json'))
    assert.equal((await fresh.read()).resumePlayback, true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('ordinary restart accepts only an unforced successful non-signaled exit', () => {
  assert.doesNotThrow(() => assertOrdinaryAcceptanceExit({ forced: false, code: 0, signal: null }))
  for (const cleanup of [
    { forced: false, code: 1, signal: null }, { forced: false, code: null, signal: 'SIGABRT' },
    { forced: true, code: 0, signal: null }, { forced: false, code: null, signal: null },
    { forced: false, code: 0, signal: 'SIGTERM' }
  ]) assert.throws(() => assertOrdinaryAcceptanceExit(cleanup), { name: 'AssertionError' })
})

test('local playback entry points explicitly prepare their non-recording scenario', () => {
  for (const file of ['playback-acceptance.mjs', 'playback-media-acceptance.mjs']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /await prepareNonRecordingPlayback\(page\)/, file)
  }
})
