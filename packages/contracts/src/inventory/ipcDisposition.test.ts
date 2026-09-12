import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IPC } from '../ipc-channels'
import { MANAGE_OPERATIONS } from '../manage/operations'
import { MANAGE_OPERATION_INPUTS } from '../manage/inputs'
import { IPC_DISPOSITION } from './ipcDisposition'

test('every IPC declaration has exactly one frozen disposition', () => {
  const ipcKeys = Object.keys(IPC)
  const dispositionKeys = Object.keys(IPC_DISPOSITION)
  assert.equal(ipcKeys.length, 282)
  assert.deepEqual(dispositionKeys.sort(), ipcKeys.sort())
})

test('every manageUseCase referenced by IPC exists and has an input schema', () => {
  const missing: string[] = []
  for (const [channel, disposition] of Object.entries(IPC_DISPOSITION)) {
    const useCase = disposition.manageUseCase
    if (!useCase) continue
    if (!(useCase in MANAGE_OPERATIONS)) missing.push(`${channel} -> ${useCase} (meta)`)
    if (!(useCase in MANAGE_OPERATION_INPUTS)) missing.push(`${channel} -> ${useCase} (input)`)
  }
  assert.deepEqual(missing, [])
})

test('new protocol operations are frozen even when they have no IPC ancestor', () => {
  for (const operation of [
    'handshake.get',
    'writer.claim',
    'uploads.create',
    'play.grant',
    'tasks.get',
    'operations.get',
    'migration.preview',
    'migration.enable',
    'migration.abandon'
  ] as const) {
    assert.ok(operation in MANAGE_OPERATIONS, operation)
    assert.ok(operation in MANAGE_OPERATION_INPUTS, operation)
  }
})

test('compat and remote-unavailable entries record a reason', () => {
  for (const [channel, disposition] of Object.entries(IPC_DISPOSITION)) {
    if (disposition.kind === 'compatMerged') {
      assert.ok(disposition.compatTarget, channel)
      assert.equal(disposition.compatTarget && disposition.compatTarget in IPC, true)
    }
    if (disposition.kind === 'remoteUnavailable' || disposition.kind === 'compatMerged') {
      assert.ok(disposition.notes.length > 0, channel)
    }
  }
})
