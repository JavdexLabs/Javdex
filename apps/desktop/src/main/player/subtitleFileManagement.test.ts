import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlaybackSource } from './playbackSource'
import { createSubtitleFileManagement } from './subtitleFileManagement'

test('native picker cancellation is a no-op; resource changes while picking reject association', async () => {
  const target = { libraryId: 1, videoId: 2, resourceId: 3 }
  const source = { target, mode: 'local', resumeKey: 'resource' } as PlaybackSource
  let picked: string[] | null = null, invalid = false, associates = 0, changes = 0
  const files = { files: [], error: null }
  const management = createSubtitleFileManagement({
    resolve: async input => { assert.deepEqual(input, target); return source },
    files: async input => { assert.equal(input, source); return files },
    validate: async () => { if (invalid) throw new Error('resource changed') },
    choose: async () => picked,
    associate: async (input, paths) => { assert.equal(input, source); assert.deepEqual(paths, picked); associates++ },
    changed: () => { changes++ }
  })
  assert.equal(await management.list(target), files)
  assert.equal(await management.add(target), null)
  assert.equal(associates, 0)
  picked = ['selected.srt']; invalid = true
  await assert.rejects(management.add(target), /resource changed/)
  assert.equal(associates, 0)
  invalid = false
  assert.equal(await management.add(target), files)
  assert.equal(associates, 1)
  assert.equal(changes, 1)
})
