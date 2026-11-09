import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CatalogBackend } from '../application/catalogBackend'
import { readActiveScanProgress } from './scanHandlers'

test('reads local scan progress without starting a scan, including pre-progress initialization', async () => {
  const backend = { mode: 'local' } as CatalogBackend
  assert.deepEqual(await readActiveScanProgress(backend, () => null), [])
  assert.deepEqual(await readActiveScanProgress(backend, () => ({ phase: 'started', libraryId: 1, runId: 'run', trigger: 'manual' })), [
    { libraryId: 1, runId: 'run', progress: { scanned: 0, imported: 0, currentFile: '' } }
  ])
  const progress = { scanned: 12, imported: 3, currentFile: 'example.mp4' }
  assert.deepEqual(await readActiveScanProgress(backend, () => ({ phase: 'progress', libraryId: 1, runId: 'run', trigger: 'manual', progress })), [
    { libraryId: 1, runId: 'run', progress }
  ])
})

test('remote active scans can be beyond the first page and never include finished or unrelated tasks', async () => {
  const offsets: number[] = []
  const backend = { mode: 'remote', tasks: { list: async ({ offset }: { offset: number }) => {
    offsets.push(offset)
    if (!offset) return Array.from({ length: 100 }, () => ({ kind: 'scan', state: 'succeeded', libraryId: 1 }))
    return [
      { kind: 'scan', state: 'running', libraryId: 2, taskId: 'remote', counts: { scanned: 12 }, label: 'example.mp4' },
      { kind: 'scrape', state: 'running', libraryId: 2 },
      { kind: 'scan', state: 'failed', libraryId: 2 }
    ]
  } } } as unknown as CatalogBackend
  assert.deepEqual(await readActiveScanProgress(backend, () => { throw new Error('Remote reads must not consult local scan state') }), [
    { libraryId: 2, runId: 'remote', progress: { scanned: 12, imported: 0, currentFile: 'example.mp4' } }
  ])
  assert.deepEqual(offsets, [0, 100])
  backend.tasks.list = async () => { throw new Error('Disconnected') }
  await assert.rejects(readActiveScanProgress(backend), /Disconnected/)
})
