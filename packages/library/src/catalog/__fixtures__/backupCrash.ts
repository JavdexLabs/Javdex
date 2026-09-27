import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openIsolatedCatalog } from '../catalogMigration'
import { backupControl, backupFile, writeBackupChunk, type BackupHost } from '../catalogBackup'
import { ensureCatalogIdentity } from '../catalogIdentity'
import { sha256File } from '../catalogMigrationArchive'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'

// Child-process fixture: abrupt exit leaves no opportunity for JS cleanup/rollback.
async function run(): Promise<void> {
  const [directory, stage] = process.argv.slice(2)
  function catalog(name: string) {
    const root = path.join(directory, name)
    fs.mkdirSync(path.join(root, 'images/covers'), { recursive: true })
    const db = openIsolatedCatalog(path.join(root, 'library.db'))
    ensureCatalogIdentity({}, db)
    const video = insertTestVideoWithFile(db, { code: name, title: name, libraryId: 1, filePath: path.join(root, 'original.avi') })
    db.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run('covers/original.png', video.videoId)
    fs.writeFileSync(path.join(root, 'images/covers/original.png'), name)
    const host: BackupHost = { mode: 'local', appVersion: 'test', userDataPath: root, imagesDir: path.join(root, 'images') }
    const command = (input: Parameters<typeof backupControl>[2]) => backupControl(host, db, input).jobs[0]
    async function wait(id: string, phase: string) {
      for (let n = 0; n < 500; n++) {
        const job = command({ action: 'status', id })
        if (job.phase === phase) return job
        if (['failed', 'recoveryRequired'].includes(job.phase)) throw new Error(job.error)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('fixture timeout')
    }
    return { root, db, host, command, wait }
  }
  const source = catalog('source'); const target = catalog('target')
  const backupId = randomUUID()
  source.command({ action: 'create', id: backupId }); await source.wait(backupId, 'completed')
  const file = backupFile(source.host, backupId, 'local'); const bytes = fs.readFileSync(file)
  const id = randomUUID()
  target.command({ action: 'receive', id, bytes: bytes.length, sha256: sha256File(file) })
  writeBackupChunk(target.host, id, 'local', 0, bytes)
  target.command({ action: 'inspect', id }); await target.wait(id, 'ready')
  const preview = target.command({ action: 'preview', id, mappings: [], omitUnrooted: true }).preview!
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify({ id }))
  const copy = fs.copyFileSync
  fs.copyFileSync = (from, to, flags) => {
    copy(from, to, flags)
    const destination = String(to).replaceAll('\\', '/')
    if ((stage === 'protecting' && destination.includes('/target/backups/operations/') && destination.includes('/export/images/')) ||
      (stage === 'images' && destination.includes(`/restore-${id}/`))) process.exit(23)
  }
  const exec = target.db.exec.bind(target.db)
  target.db.exec = sql => {
    const result = exec(sql)
    if (stage === 'beforeCommit' && sql.endsWith(' AS backupsrc')) process.exit(23)
    return result
  }
  target.host.onRestored = () => { if (stage === 'committed') process.exit(23) }
  target.command({ action: 'restore', id, digest: preview.digest })
  await target.wait(id, 'completed')
  throw new Error('crash checkpoint was not reached')
}
void run().catch(error => { console.error(error); process.exit(1) })
