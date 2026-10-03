import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPlaybackVolume } from './playbackVolume'
import { createThisComputerSettingsStore, DEFAULT_THIS_COMPUTER_SETTINGS } from '../desktop/thisComputerSettingsStore'

test('device volume is bounded, coalesced and survives a new settings store without viewing data', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-volume-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'this-computer.json')
  const store = createThisComputerSettingsStore(file)
  let writes = 0
  const volume = createPlaybackVolume({ read: store.read, write: async patch => { writes++; return store.write(patch) } })
  assert.equal(await volume.read(), 50)
  assert.equal(fs.existsSync(file), false, 'opening does not persist watching information or defaults')
  volume.remember(25); volume.remember(0)
  assert.equal(await volume.read(), 0, 'next file gets the pending preference immediately')
  await volume.flush()
  assert.equal(writes, 1)
  assert.equal(await createPlaybackVolume(createThisComputerSettingsStore(file)).read(), 0)
  volume.remember(200); await volume.flush()
  assert.equal((await store.read()).playbackVolume, 100)
  volume.remember(NaN); await volume.flush()
  assert.equal(writes, 2)
  assert.deepEqual(fs.readdirSync(root), ['this-computer.json'])
  assert.ok(!/position|resourceId|locator|catalogId/.test(fs.readFileSync(file, 'utf8')))
})

test('failed volume save stays usable and retries on flush', async () => {
  let fail = true
  const patches: unknown[] = []
  const volume = createPlaybackVolume({
    read: async () => { throw new Error('unavailable') },
    write: async patch => {
      if (fail) throw new Error('read-only')
      patches.push(patch)
      return { ...DEFAULT_THIS_COMPUTER_SETTINGS, ...patch }
    }
  })
  assert.equal(await volume.read(), 50)
  volume.remember(72)
  await volume.flush()
  assert.equal(await volume.read(), 72)
  fail = false
  await volume.flush()
  assert.deepEqual(patches, [{ playbackVolume: 72 }])
})
