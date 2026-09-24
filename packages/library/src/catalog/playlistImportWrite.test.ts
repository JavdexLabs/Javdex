import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { writePlaylistImport } from './playlistImportWrite'

let root: string | undefined
afterEach(() => { closeDatabase(); if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-import-write-'))
  const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
  db.exec("INSERT INTO videos(id,code) VALUES(11,'ABC-011'),(12,'ABC-012')")
  return db
}

it('shares ordered deduplication while preserving the explicit ownership policy', () => {
  const db = fixture()
  const entries = [12, 11, 12].map(videoId => ({ kind: 'existing' as const, videoId }))
  const local = writePlaylistImport({ destination: { kind: 'create', name: 'Local' },
    libraryId: 1, entries, reusedMembership: 'preserve' }, db)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships').get() as { n: number }).n, 0)
  const remote = writePlaylistImport({ destination: { kind: 'create', name: 'Remote' },
    libraryId: 1, entries, reusedMembership: 'ensure-target' }, db)
  for (const result of [local, remote]) {
    assert.deepEqual(result.entries.map(entry => entry.addedToPlaylist), [true, true, false])
    assert.deepEqual(db.prepare('SELECT video_id FROM playlist_video WHERE playlist_id = ? ORDER BY position')
      .all(result.playlistId), [{ video_id: 12 }, { video_id: 11 }])
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships').get() as { n: number }).n, 2)
})

it('appends new videos and links without duplicating original members', () => {
  const db = fixture()
  const initial = writePlaylistImport({ destination: { kind: 'create', name: 'List' }, libraryId: 1,
    entries: [{ kind: 'existing', videoId: 11 }], reusedMembership: 'preserve' }, db)
  const link = { label: 'Source', url: 'https://example.test/item' }
  const result = writePlaylistImport({ destination: { kind: 'append', playlistId: initial.playlistId },
    libraryId: 1, sourceLinks: [link, link], reusedMembership: 'preserve', entries: [
      { kind: 'existing', videoId: 11 },
      { kind: 'create', code: 'NEW-001', title: 'New', links: [link, link] }
    ] }, db)
  assert.equal(result.playlistRelatedLinksAdded, 1)
  assert.equal(result.entries[0].alreadyInPlaylist, true)
  assert.equal(result.entries[1].created, true)
  assert.equal(result.entries[1].membershipAdded, true)
  assert.equal(result.entries[1].relatedLinksAdded, 1)
  assert.deepEqual(db.prepare('SELECT video_id,position FROM playlist_video WHERE playlist_id=? ORDER BY position').all(initial.playlistId),
    [{ video_id: 11, position: 0 }, { video_id: result.entries[1].videoId, position: 1 }])
})

it('rolls back playlist, new videos, memberships and links when a later item fails', () => {
  const db = fixture()
  assert.throws(() => writePlaylistImport({ destination: { kind: 'create', name: 'Must roll back' },
    libraryId: 1, reusedMembership: 'ensure-target', sourceLinks: [{ label: 'Source', url: 'https://example.test/list' }],
    entries: [{ kind: 'create', code: 'NEW-001', title: null }, { kind: 'existing', videoId: 9999 }]
  }, db), /MATCH_SNAPSHOT_STALE/)
  for (const table of ['playlists', 'playlist_video', 'playlist_links', 'library_video_memberships']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0)
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }).n, 2)
})
