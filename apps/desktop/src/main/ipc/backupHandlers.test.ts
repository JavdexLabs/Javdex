import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import type { IpcMainInvokeEvent } from 'electron'
import { test } from 'node:test'
import { IPC, type IpcChannel } from '@shared/ipc-channels'
import type { AppIpcContract } from '@shared/appIpcContract'
import type { DesktopBackupFileResult, BackupResponse } from '@shared/protocol/backup'
import { configureLibraryHost } from '@library/runtime/host'
import { createUnconfiguredRemoteBackend } from '../backends/remote/unconfiguredRemoteBackend'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import { appIpcSchemas } from './ipcCommandSchemas'
import { registerBackupHandlers } from './backupHandlers'

test('failed local exports remain inspectable without blocking retries; concurrent starts are rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-backup-ipc-'))
  configureLibraryHost({ userDataPath: () => dir })
  const backend = createUnconfiguredRemoteBackend({ state: 'available' })
  backend.backup.request = async () => ({ jobs: [] })
  const handlers = new Map<IpcChannel, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const adapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas, (channel, handler) => handlers.set(channel, handler))
  const workers: EventEmitter[] = []
  const messages: unknown[] = []
  registerBackupHandlers({ getWindow: () => null } as Parameters<typeof registerBackupHandlers>[0], backend, adapter, () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: (message: unknown) => messages.push(message) })
    workers.push(worker)
    return worker as unknown as Worker
  })
  const call = async (channel: IpcChannel, input: unknown) => handlers.get(channel)!({} as IpcMainInvokeEvent, input)
  try {
    const start = call(IPC.BACKUP_FILE, { action: 'importLocal' })
    await assert.rejects(call(IPC.BACKUP_FILE, { action: 'importLocal' }), /导出已在进行/)
    const first = await start as DesktopBackupFileResult
    workers[0].emit('message', { error: '模拟源图片读取失败' })
    workers[0].emit('exit', 0)
    const failed = await call(IPC.BACKUP_CONTROL, { action: 'status', id: first.job!.id }) as BackupResponse
    assert.equal(failed.jobs[0].phase, 'failed')
    const removal = await call(IPC.BACKUP_CONTROL, { action: 'previewRemoval', id: first.job!.id }) as BackupResponse
    assert.equal(removal.removal?.fileCount, 0)
    assert.match(removal.removal!.blockedReason!, /本机导出副本保留/)
    await assert.rejects(call(IPC.BACKUP_CONTROL, { action: 'removeRecord', id: first.job!.id, deleteFiles: true, digest: removal.removal!.digest }), /没有服务端备份可清理/)
    await call(IPC.BACKUP_CONTROL, { action: 'removeRecord', id: first.job!.id })
    assert.equal((await call(IPC.BACKUP_CONTROL, { action: 'list' }) as BackupResponse).jobs.length, 0)
    const second = await call(IPC.BACKUP_FILE, { action: 'importLocal' }) as DesktopBackupFileResult
    await assert.rejects(call(IPC.BACKUP_CONTROL, { action: 'removeRecord', id: second.job!.id }), /导出结束/)
    assert.notEqual(second.job!.id, first.job!.id)
    workers[1].emit('message', { job: { ...second.job, phase: 'awaitingImages', missingImages: { paths: ['covers/missing.jpg'], digest: 'a'.repeat(64) } } })
    await call(IPC.BACKUP_CONTROL, { action: 'confirmMissingImages', id: second.job!.id, digest: 'a'.repeat(64) })
    assert.equal(messages.length, 1)
    await assert.rejects(call(IPC.BACKUP_CONTROL, { action: 'confirmMissingImages', id: second.job!.id, digest: 'b'.repeat(64) }), /清单已变化/)
    await assert.rejects(call(IPC.BACKUP_FILE, { action: 'importLocal' }), /导出已在进行/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('IPC preserves deletion preview metadata and forwards the explicit file cleanup confirmation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-backup-removal-ipc-'))
  configureLibraryHost({ userDataPath: () => dir })
  const backend = createUnconfiguredRemoteBackend({ state: 'available' })
  const removal = { digest: 'b'.repeat(64), bytes: 1024, fileCount: 1, location: '/data/backups', host: 'remote' as const, automaticBackup: true, retainedAutomaticBackup: false }
  const requests: unknown[] = []
  backend.backup.request = async input => { requests.push(input); return { jobs: [], removal } }
  const handlers = new Map<IpcChannel, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const adapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas, (channel, handler) => handlers.set(channel, handler))
  registerBackupHandlers({ getWindow: () => null } as Parameters<typeof registerBackupHandlers>[0], backend, adapter)
  const call = async (input: unknown) => handlers.get(IPC.BACKUP_CONTROL)!({} as IpcMainInvokeEvent, input) as Promise<BackupResponse>
  const id = 'aa31510e-6389-48d9-ad58-225635954dbc'
  try {
    assert.deepEqual((await call({ action: 'previewRemoval', id })).removal, removal)
    const confirmation = { action: 'removeRecord', id, deleteFiles: true, digest: removal.digest }
    await call(confirmation)
    assert.deepEqual(requests, [{ action: 'previewRemoval', id }, confirmation])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
