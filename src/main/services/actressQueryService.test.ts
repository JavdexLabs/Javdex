import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { createActressQueryService } from './actressQueryService'
import type { ActressFaceScanManifestItem, ActressListItem } from '@shared/actressTypes'

let tempRoot: string | null = null
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-query-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  const insertActress = db.prepare(
    'INSERT INTO actresses (main_name, avatar_path, avatar_source_path, gender) VALUES (?, ?, ?, ?)'
  )
  insertActress.run('Alpha', 'avatars/alpha.jpg', 'avatar_sources/alpha.jpg', 'female')
  insertActress.run('Beta', null, null, 'female')

  const insertName = db.prepare(
    "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'main', 1)"
  )
  const insertOwnership = db.prepare(
    'INSERT INTO actress_name_ownership (normalized_name, actress_id) VALUES (?, ?)'
  )
  insertName.run(1, 'Alpha')
  insertName.run(2, 'Beta')
  insertOwnership.run('alpha', 1)
  insertOwnership.run('beta', 2)

  for (const relPath of [
    'avatars/alpha.jpg',
    'avatar_sources/alpha.jpg'
  ]) {
    const absolutePath = path.join(tempRoot, 'media_assets', relPath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, PNG_1X1)
  }
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('actressQueryService.listActresses', () => {
  it('returns a stable page and the full matching total from the real database', () => {
    setupDb()
    const service = createActressQueryService()

    const first = service.listActresses({ gender: 'all', sortBy: 'video_count', limit: 1, offset: 0 })
    const second = service.listActresses({ gender: 'all', sortBy: 'video_count', limit: 1, offset: 1 })

    assert.equal(first.total, 2)
    assert.equal(second.total, 2)
    assert.deepEqual(first.items.map((item) => item.main_name), ['Alpha'])
    assert.deepEqual(second.items.map((item) => item.main_name), ['Beta'])
  })

  it('reuses one exact avatar-filter snapshot across subsequent pages', () => {
    let reads = 0
    const items = [1, 2, 3].map(
      (id) => ({ id, main_name: `Actress ${id}` }) as ActressListItem
    )
    const service = createActressQueryService({
      inspectImage: () => ({ usable: true, fingerprint: 'test' }),
      listPage: () => {
        reads += 1
        return {
          items,
          total: items.length,
          statusCounts: { all: 3, success: 0, unscraped: 3, failed: 0 }
        }
      }
    })

    const first = service.listActresses({ avatar: 'with', limit: 2, offset: 0 })
    const second = service.listActresses({ avatar: 'with', limit: 2, offset: 2 })

    assert.equal(reads, 1)
    assert.deepEqual(first.items.map((item) => item.id), [1, 2])
    assert.deepEqual(second.items.map((item) => item.id), [3])
  })

  it('refreshes the avatar-filter snapshot whenever the first page reloads', () => {
    let reads = 0
    const service = createActressQueryService({
      inspectImage: () => ({ usable: false, fingerprint: null }),
      listPage: () => {
        reads += 1
        const item = { id: reads, main_name: `Read ${reads}` } as ActressListItem
        return {
          items: [item],
          total: 1,
          statusCounts: { all: 1, success: 0, unscraped: 1, failed: 0 }
        }
      }
    })

    const first = service.listActresses({ avatar: 'without', limit: 1, offset: 0 })
    const refreshed = service.listActresses({ avatar: 'without', limit: 1, offset: 0 })

    assert.equal(reads, 2)
    assert.equal(first.items[0]?.id, 1)
    assert.equal(refreshed.items[0]?.id, 2)
  })

  it('inspects avatar health and fingerprints outside the database repository', () => {
    setupDb()
    const service = createActressQueryService()

    const withAvatar = service.listActresses({ gender: 'all', avatar: 'with', limit: 10 })
    const withoutAvatar = service.listActresses({ gender: 'all', avatar: 'without', limit: 10 })

    assert.deepEqual(withAvatar.items.map((item) => item.main_name), ['Alpha'])
    assert.ok(withAvatar.items[0]?.avatar_fingerprint)
    assert.deepEqual(withoutAvatar.items.map((item) => item.main_name), ['Beta'])
    assert.deepEqual(withAvatar.statusCounts, {
      all: 1,
      success: 0,
      unscraped: 1,
      failed: 0
    })
  })
})

describe('actressQueryService.listFaceScanManifest', () => {
  it('exposes the dedicated minimal manifest through the query seam', () => {
    const manifest: ActressFaceScanManifestItem[] = [{
      id: 7,
      main_name: 'Face Candidate',
      avatar_path: 'avatars/7.jpg',
      avatar_fingerprint: 'fingerprint-7'
    }]
    const service = createActressQueryService({
      listFaceScanCandidates: () => manifest.map(({ avatar_fingerprint: _, ...candidate }) => candidate),
      inspectImage: () => ({ usable: true, fingerprint: 'fingerprint-7' })
    })

    assert.deepEqual(service.listFaceScanManifest(), manifest)
  })
})


it('delegates avatar count without reading the legacy list or inspecting images', () => {
  let calls = 0
  const service = createActressQueryService({
    countAvatarCropTargets: () => { calls++; return 300382 },
    listLegacy: () => { throw new Error('Legacy list forbidden') },
    inspectImage: () => { throw new Error('Image inspection forbidden') }
  })
  assert.equal(service.countAvatarCropTargets(), 300382)
  assert.equal(calls, 1)
})
