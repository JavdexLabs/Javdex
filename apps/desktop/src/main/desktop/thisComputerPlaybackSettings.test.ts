import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createThisComputerSettingsStore } from './thisComputerSettingsStore'

test('shared playback settings persist all three explicit choices without rewriting on read', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-settings-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'this-computer.json')
  for (const mode of ['auto', 'gpu', 'cpu'] as const) {
    const original = JSON.stringify({ playbackRenderMode: mode })
    writeFileSync(file, original)
    const store = createThisComputerSettingsStore(file)
    assert.equal((await store.read()).playbackRenderMode, mode)
    assert.equal(readFileSync(file, 'utf8'), original)
    await store.write({ theme: 'dark' })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.playbackRenderMode, mode)
  }
  writeFileSync(file, JSON.stringify({ playbackRenderMode: 'gpu' }))
  assert.equal((await createThisComputerSettingsStore(file).read()).playbackRenderMode, 'gpu')
})
