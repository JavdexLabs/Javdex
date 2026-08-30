import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import type {
  PlaylistImportControlCommand,
  PlaylistImportModule,
  PlaylistImportSnapshot
} from '@shared/playlistImportTypes'
import {
  bindPlaylistImportRendererLifecycle,
  cancelForegroundPlaylistImport
} from './playlistImportHandlers'

function snapshot(phase: PlaylistImportSnapshot['phase']): PlaylistImportSnapshot {
  return {
    runId: 'foreground-import',
    revision: 7,
    cursor: 7,
    phase,
    summary: phase,
    frozenInput: {
      sourceUrl: 'https://example.test/list',
      displayUrl: 'https://example.test/list',
      sourceHost: 'example.test',
      targetLibraryId: 1,
      targetLibraryNameAtStart: '默认媒体库',
      destination: { kind: 'create' },
      autoCreateUnmatchedVideos: true,
      saveDetailLinks: true,
      saveSourcePlaylistLink: false,
      policyVersion: 1
    },
    progress: {
      pagesRead: 0,
      scrollWindowsRead: 0,
      sourceItems: 0,
      uniqueItems: 0,
      directReuses: 0,
      detailPending: 0,
      userDecisionsPending: 0,
      plannedCreates: 0,
      skippedItems: 0,
      appliedItems: 0
    }
  }
}

describe('playlist import renderer lifecycle', () => {
  it('binds every recreated renderer once and cancels only on full navigation or loss', () => {
    const boundOwners = new WeakSet<WebContents>()
    const first = new EventEmitter() as unknown as WebContents
    const recreated = new EventEmitter() as unknown as WebContents
    let disconnects = 0
    const disconnected = (): void => { disconnects += 1 }

    bindPlaylistImportRendererLifecycle(first, boundOwners, disconnected)
    bindPlaylistImportRendererLifecycle(first, boundOwners, disconnected)
    first.emit('did-start-navigation', {}, 'https://example.test/#route', true, true)
    assert.equal(disconnects, 0)
    first.emit('did-start-navigation', {}, 'https://example.test/', false, true)
    assert.equal(disconnects, 1)

    bindPlaylistImportRendererLifecycle(recreated, boundOwners, disconnected)
    recreated.emit('render-process-gone')
    assert.equal(disconnects, 2)
  })

  it('cancels a non-terminal foreground import when its renderer disconnects', async () => {
    const commands: PlaylistImportControlCommand[] = []
    const module = {
      snapshot: () => snapshot('waiting_user'),
      control: async (_runId: string, command: PlaylistImportControlCommand) => {
        commands.push(command)
        return snapshot('cancelled')
      }
    } satisfies Pick<PlaylistImportModule, 'snapshot' | 'control'>

    await cancelForegroundPlaylistImport(module)

    assert.deepEqual(commands, [{
      kind: 'cancel',
      idempotencyKey: 'renderer-disconnected:foreground-import:7'
    }])
  })

  it('leaves terminal imports untouched', async () => {
    for (const phase of ['completed', 'failed', 'cancelled'] as const) {
      let controlCalls = 0
      await cancelForegroundPlaylistImport({
        snapshot: () => snapshot(phase),
        control: async () => {
          controlCalls += 1
          return snapshot(phase)
        }
      })
      assert.equal(controlCalls, 0, phase)
    }
  })
})
