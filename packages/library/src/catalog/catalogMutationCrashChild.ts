import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { readCatalogIdentity } from './catalogIdentity'
import { commitCatalogMutation } from './catalogOperations'

function main(): void {
  const root = process.env.JAVDEX_TEST_USER_DATA
  if (!root) throw new Error('JAVDEX_TEST_USER_DATA required')
  initDatabaseAtPath(path.join(root, 'library.db'))
  const identity = readCatalogIdentity()
  if (!identity) throw new Error('catalog identity missing')
  const videoId = Number(process.env.JAVDEX_CRASH_VIDEO_ID ?? '0')
  if (!videoId) throw new Error('JAVDEX_CRASH_VIDEO_ID required')
  const title = process.env.JAVDEX_CRASH_TITLE ?? 'should-rollback'
  const operationId = process.env.JAVDEX_CRASH_OPERATION_ID ?? randomUUID()
  const current = getDb()
    .prepare('SELECT generation, revision FROM videos WHERE id = ?')
    .get(videoId) as { generation: number; revision: number } | undefined
  if (!current) throw new Error('video missing')
  commitCatalogMutation(
    {
      operationId,
      operation: 'videos.edit',
      expectedVersions: { V: current },
      input: { videoId, fields: { title } },
      writerEpoch: identity.writerEpoch
    },
    () => {
      getDb()
        .prepare('UPDATE videos SET title = ?, revision = revision + 1 WHERE id = ?')
        .run(title, videoId)
      const versions = getDb()
        .prepare('SELECT generation, revision FROM videos WHERE id = ?')
        .get(videoId) as { generation: number; revision: number }
      return { ok: true, videoId, versions: { V: versions } }
    }
  )
}

if (process.env.JAVDEX_MUTATION_CRASH_CHILD === '1') {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exit(1)
  } finally {
    try {
      closeDatabase()
    } catch {
      // SIGKILL never reaches here.
    }
  }
}
