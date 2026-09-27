import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { configureLibraryHost } from '@library/runtime/host'
import { backupControl, backupFile, recoverBackupOperations } from '@library/catalog/catalogBackup'
import { CURRENT_SCHEMA_VERSION } from '@library/db/migrations'

async function run(): Promise<void> {
  const { userDataPath, imagesDir, appVersion, id } = workerData as { userDataPath: string; imagesDir: string; appVersion: string; id: string }
  configureLibraryHost({ userDataPath: () => userDataPath, assets: { assetEncryption: () => false, mediaAssetsPath: () => imagesDir } })
  const file = path.join(userDataPath, 'data', 'library.db')
  if (!fs.existsSync(file)) throw new Error('此电脑没有可导入的本机资料库')
  const db = new Database(file, { fileMustExist: true, timeout: 0 })
  try {
    if (db.pragma('user_version', { simple: true }) !== CURRENT_SCHEMA_VERSION) throw new Error('请先在本地模式打开资料库，完成版本升级后再导入')
    // Reject an existing database writer before starting the isolated export.
    db.exec('BEGIN IMMEDIATE; ROLLBACK;')
    const host = { mode: 'local' as const, isolatedSource: true, appVersion, userDataPath, imagesDir,
      onProgress: (job: import('@shared/protocol/backup').BackupJob) => parentPort?.postMessage({ job }) }
    recoverBackupOperations(host, db)
    backupControl(host, db, { action: 'create', id })
    parentPort?.on('message', message => {
      if (message === 'cancel') backupControl(host, db, { action: 'cancel', id })
      else if (message?.action === 'confirmMissingImages' && message.id === id) backupControl(host, db, message)
    })
    for (;;) {
      const job = backupControl(host, db, { action: 'status', id }).jobs[0]
      parentPort?.postMessage({ job })
      if (job.phase === 'completed') { parentPort?.postMessage({ file: backupFile(host, id, 'local') }); return }
      if (job.phase === 'cancelled') return
      if (['failed', 'recoveryRequired'].includes(job.phase)) throw new Error(job.error ?? '本机导出失败')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  } finally { parentPort?.removeAllListeners('message'); db.close() }
}
void run().catch(error => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })).finally(() => parentPort?.close())
