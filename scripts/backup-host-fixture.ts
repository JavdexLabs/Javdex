import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { openIsolatedCatalog } from '../packages/library/src/catalog/catalogMigration'
import { ensureCatalogIdentity } from '../packages/library/src/catalog/catalogIdentity'
import { configureLibraryHost } from '../packages/library/src/runtime/host'
import { encryptPlain, isEncryptedBlob } from '../packages/library/src/assetCrypto'
import { setPathAlias } from '../packages/library/src/assetPathAliases'
import { insertTestVideoWithFile } from '../packages/library/src/db/testVideoFixtures'
import { backupControl, writeBackupChunk } from '../packages/library/src/catalog/catalogBackup'
import { sha256File } from '../packages/library/src/catalog/catalogMigrationArchive'

// Invoked by backup-docker-smoke with a freshly generated fixture directory.
async function main(): Promise<void> {
  const dir = process.argv[2]
  if (process.argv[3]) {
    const root = path.join(dir, 'roundtrip-target')
    fs.mkdirSync(root, { recursive: true })
    const host = { mode: 'local' as const, appVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version, userDataPath: root, imagesDir: path.join(root, 'images') }
    configureLibraryHost({ userDataPath: () => root })
    const db = openIsolatedCatalog(path.join(root, 'library.db')); ensureCatalogIdentity({}, db)
    const id = randomUUID(); const bytes = fs.readFileSync(process.argv[3])
    const command = (input: Parameters<typeof backupControl>[2]) => backupControl(host, db, input).jobs[0]
    const wait = async (phase: string) => {
      for (let i = 0; i < 500; i++) {
        const job = command({ action: 'status', id })
        if (job.phase === phase) return job
        if (['failed', 'recoveryRequired'].includes(job.phase)) throw new Error(job.error)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('roundtrip restore timeout')
    }
    try {
      command({ action: 'receive', id, bytes: bytes.length, sha256: sha256File(process.argv[3]) })
      writeBackupChunk(host, id, 'local', 0, bytes)
      command({ action: 'inspect', id }); await wait('ready')
      const preview = command({ action: 'preview', id, mappings: [{ sourceRootId: 1, target: { kind: 'local', path: path.join(dir, '来源 目录') } }] }).preview!
      assert.equal(preview.missingResources, 0)
      command({ action: 'restore', id, digest: preview.digest }); await wait('completed')
      const row = db.prepare('SELECT code,cover_path FROM videos').get() as { code: string; cover_path: string }
      assert.equal(row.code, 'BACKUP-1')
      assert.equal(fs.readFileSync(path.join(host.imagesDir, row.cover_path), 'utf8'), 'original-image-plaintext')
      assert.equal((db.prepare('SELECT locator FROM video_resources').get() as { locator: string }).locator, path.join(dir, '来源 目录/电影 avi.avi'))
    } finally { db.close() }
    return
  }
  const images = path.join(dir, 'images')
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  fs.mkdirSync(path.join(images, 'covers'), { recursive: true })
  configureLibraryHost({ userDataPath: () => dir, assets: { assetEncryption: () => true, mediaAssetsPath: () => images } })
  const db = openIsolatedCatalog(path.join(dir, 'data/library.db'))
  ensureCatalogIdentity({}, db)
  const mediaRoot = path.join(dir, '来源 目录')
  fs.mkdirSync(mediaRoot)
  const videoFile = path.join(mediaRoot, '电影 avi.avi')
  fs.writeFileSync(videoFile, 'original-video-untouched')
  const video = insertTestVideoWithFile(db, { code: 'BACKUP-1', title: '跨设备资料', filePath: videoFile, libraryId: 1 })
  db.prepare('INSERT INTO media_library_roots (id, library_id, path, normalized_path) VALUES (1,1,?,?)').run(mediaRoot, mediaRoot.toLowerCase())
  db.prepare('UPDATE video_resources SET root_id=1 WHERE video_id=?').run(video.videoId)
  db.prepare("UPDATE videos SET cover_path='covers/opaque.avpk' WHERE id=?").run(video.videoId)
  db.prepare("INSERT INTO video_assets (video_id,type,local_path) VALUES (?, 'sample', 'samples/缺失旧样张.enc')").run(video.videoId)
  const encrypted = encryptPlain(Buffer.from('original-image-plaintext'), '.png')
  fs.writeFileSync(path.join(images, 'covers/opaque.avpk'), encrypted)
  setPathAlias('covers/opaque.avpk', 'covers/中文 封面.png')
  db.close()
  const worker = new Worker(path.resolve('out/main/backupSourceWorker.js'), {
    execArgv: [], workerData: { id: randomUUID(), userDataPath: dir, imagesDir: images, appVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version }
  })
  let file: string | undefined
  let confirmed = false
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('isolated export worker timed out')), 30000)
      worker.on('message', message => {
        if (message.error) reject(new Error(message.error))
        if (message.file) file = message.file
        if (message.job?.phase === 'awaitingImages' && !confirmed) {
          assert.deepEqual(message.job.missingImages.paths, ['samples/缺失旧样张.enc'])
          confirmed = true
          worker.postMessage({ action: 'confirmMissingImages', id: message.job.id, digest: message.job.missingImages.digest })
        }
      })
      worker.on('error', reject)
      worker.on('exit', code => { clearTimeout(timer); code === 0 && file ? resolve() : reject(new Error(`export failed: ${code}`)) })
    })
    assert.equal(fs.readFileSync(videoFile, 'utf8'), 'original-video-untouched')
    assert.equal(confirmed, true)
    assert.ok(isEncryptedBlob(fs.readFileSync(path.join(images, 'covers/opaque.avpk'))))
    fs.copyFileSync(file!, path.join(dir, 'fixture.javdex-backup'))
  } finally { await worker.terminate() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
