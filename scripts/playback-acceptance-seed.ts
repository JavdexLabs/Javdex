import fs from 'node:fs'
import path from 'node:path'
import { initDatabaseAtPath, closeDatabase } from '../packages/library/src/db/database'
import { insertTestVideoWithFile } from '../packages/library/src/db/testVideoFixtures'
import { resolveMediaLibraryRootIdentity } from '../packages/library/src/mediaLibraryRootPath'
import { configureLibraryHost } from '../packages/library/src/runtime/host'

const directory = process.env.JAVDEX_TEST_USER_DATA
const files = process.argv.slice(2)
if (!directory || !path.basename(directory).startsWith('javdex-playback-acceptance-') || !files.length) {
  throw new Error('This fixture requires an isolated playback acceptance directory and synthetic files')
}
configureLibraryHost({ userDataPath: () => directory })
fs.mkdirSync(path.join(directory, 'data'), { recursive: true })
const db = initDatabaseAtPath(path.join(directory, 'data', 'library.db'))
try {
  const timestamp = new Date().toISOString()
  const root = resolveMediaLibraryRootIdentity(path.dirname(files[0]))
  const rootId = Number(db.prepare(`INSERT INTO media_library_roots (
    library_id, path, normalized_path, real_path, normalized_real_path, device_id, inode, position, state, created_at, updated_at
  ) VALUES (1, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`).run(root.path, root.normalizedPath, root.realPath,
    root.normalizedRealPath, root.deviceId, root.inode, timestamp, timestamp).lastInsertRowid)
  const targets = files.map((file, index) => {
    const stat = fs.statSync(file)
    const inserted = insertTestVideoWithFile(db, { code: `PLAYBACK-${index + 1}`, title: `Synthetic video ${index + 1}`,
      filePath: file, libraryId: 1, rootId, fileSize: stat.size })
    db.prepare('UPDATE video_resources SET file_mtime_ms = ?, display_name = ? WHERE id = ?')
      .run(stat.mtimeMs, `测试视频 ${index + 1}`, inserted.fileId)
    return { libraryId: 1, videoId: inserted.videoId, resourceId: inserted.fileId }
  })
  fs.writeFileSync(path.join(directory, 'targets.json'), JSON.stringify(targets))
} finally { closeDatabase() }
