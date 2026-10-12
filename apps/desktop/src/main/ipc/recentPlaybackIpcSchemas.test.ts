import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IPC } from '@shared/ipc-channels'
import { appIpcSchemas } from './ipcCommandSchemas'
import { IPC_DISPOSITION } from '@shared/inventory/ipcDisposition'

test('recent playback is desktop-only with bounded input and no arbitrary file/cross-catalog target', () => {
  for (const channel of ['RECENT_PLAYBACK_METADATA', 'RECENT_PLAYBACK_PAGE', 'RECENT_PLAYBACK_REMOVE', 'RECENT_PLAYBACK_CLEAR'] as const) {
    assert.equal(IPC_DISPOSITION[channel].kind, 'desktopRetain')
    assert.equal(IPC_DISPOSITION[channel].manageUseCase, undefined)
  }
  assert.ok(appIpcSchemas[IPC.RECENT_PLAYBACK_PAGE].safeParse([{ limit: 60, offset: 0, resourceKinds: ['local'] }]).success)
  for (const input of [{ limit: 101 }, { offset: -1 }, { catalogId: 'other' }, { path: '/private/file' }, { resourceKinds: ['unknown'] }]) {
    assert.equal(appIpcSchemas[IPC.RECENT_PLAYBACK_PAGE].safeParse([input]).success, false)
  }
  for (const id of [0, -1, 1.5, Infinity]) assert.equal(appIpcSchemas[IPC.RECENT_PLAYBACK_REMOVE].safeParse([id]).success, false)
  assert.ok(appIpcSchemas[IPC.RECENT_PLAYBACK_REMOVE].safeParse([1]).success)
  assert.equal(appIpcSchemas[IPC.RECENT_PLAYBACK_CLEAR].safeParse([{ catalogId: 'other' }]).success, false)
})
