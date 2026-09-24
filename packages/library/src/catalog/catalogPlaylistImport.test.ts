import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { applyPlaylistImport } from './catalogPlaylistImport'

it('writes per-video related links during playlist import and ignores duplicate URLs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playlist-links-'))
  try {
    const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
    db.exec(`
      INSERT INTO videos(id, code) VALUES (11,'ABC-001'),(12,'ABC-002');
      INSERT INTO library_video_memberships(library_id,video_id,discovery_key)
        VALUES (1,11,1),(1,12,2);
    `)
    const first = applyPlaylistImport({
      name: '导入',
      videoIds: [11, 12],
      libraryId: 1,
      videoLinks: [
        { videoId: 11, label: 'javbus.com', url: 'https://javbus.com/abc-001' },
        { videoId: 11, label: 'dup', url: 'https://www.javbus.com/abc-001' },
        { videoId: 12, label: 'list', url: 'https://example.test/abc-002' }
      ],
      expected: { V: { generation: 1, revision: 1 } },
      operationId: '00000000-0000-4000-8000-0000000000c7',
      expectedLibraryRevision: 1
    })
    assert.equal(first.added, 2)
    assert.equal(first.relatedLinksAdded, 2)
    const second = applyPlaylistImport({
      name: '再导入',
      videoIds: [11],
      libraryId: 1,
      videoLinks: [{ videoId: 11, label: 'again', url: 'https://javbus.com/abc-001' }],
      expected: { V: { generation: 1, revision: 1 } },
      operationId: '00000000-0000-4000-8000-0000000000c8',
      expectedLibraryRevision: 1
    })
    assert.equal(second.relatedLinksAdded, 0)
    const links = getDb()
      .prepare('SELECT video_id, url FROM video_links ORDER BY video_id, id')
      .all() as Array<{ video_id: number; url: string }>
    assert.equal(links.length, 2)
    assert.equal(links.filter((row) => row.video_id === 11).length, 1)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
