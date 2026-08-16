import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { mediaAssetStore } from './mediaAssetStore'
import { createPlaylist, deletePlaylist, updatePlaylist } from './playlistService'
import { resetAssetKeyCacheForTests } from './assetCrypto'

const JPEG_1X1 = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

let tempRoot: string | null = null

function setup(): { root: string; coverSource: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playlist-service-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const coverSource = path.join(tempRoot, 'cover.jpg')
  fs.writeFileSync(coverSource, JPEG_1X1)
  return { root: tempRoot, coverSource }
}

afterEach(() => {
  closeDatabase()
  resetAssetKeyCacheForTests()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('playlistService media asset seam', () => {
  it('creates a playlist cover through MediaAssetStore and cleans it on delete', () => {
    const { coverSource } = setup()
    const id = createPlaylist({
      name: 'Watch Later',
      coverSourcePath: coverSource
    })
    const row = getDb()
      .prepare('SELECT cover_path FROM playlists WHERE id = ?')
      .get(id) as { cover_path: string }
    assert.ok(row.cover_path.startsWith('playlist_covers/'))
    assert.equal(fs.existsSync(mediaAssetStore.resolve(row.cover_path)), true)

    deletePlaylist(id)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(row.cover_path)), false)
  })

  it('deletes the previous cover only after a successful cover replacement', () => {
    const { coverSource, root } = setup()
    const id = createPlaylist({
      name: 'Queue',
      coverSourcePath: coverSource
    })
    const previous = getDb()
      .prepare('SELECT cover_path FROM playlists WHERE id = ?')
      .get(id) as { cover_path: string }
    const previousAbsolute = mediaAssetStore.resolve(previous.cover_path)
    const nextSource = path.join(root, 'next-cover.jpg')
    fs.writeFileSync(nextSource, JPEG_1X1)

    updatePlaylist(id, {
      name: 'Queue',
      coverSourcePath: nextSource
    })

    const next = getDb()
      .prepare('SELECT cover_path FROM playlists WHERE id = ?')
      .get(id) as { cover_path: string }
    assert.notEqual(next.cover_path, previous.cover_path)
    assert.equal(fs.existsSync(previousAbsolute), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(next.cover_path)), true)
  })
})
