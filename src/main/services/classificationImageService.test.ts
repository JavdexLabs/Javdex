import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { resetAssetKeyCacheForTests } from './assetCrypto'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { classificationQueryService } from './classificationQueryService'
import {
  classificationImageService,
  createClassificationImageService
} from './classificationImageService'
import { mediaAssetStore } from './mediaAssetStore'

const JPEG_1X1 = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

let tempRoot: string | null = null

function setup(): { sourcePath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-classification-image-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const sourcePath = path.join(tempRoot, 'source.jpg')
  fs.writeFileSync(sourcePath, JPEG_1X1)
  return { sourcePath }
}

function storedImagePath(table: 'organizations' | 'directors' | 'series', id: number): string | null {
  return (
    getDb().prepare(`SELECT image_path FROM ${table} WHERE id = ?`).get(id) as {
      image_path: string | null
    }
  ).image_path
}

afterEach(() => {
  closeDatabase()
  resetAssetKeyCacheForTests()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('classificationImageService', () => {
  it('imports local and remote images as owned assets and cleans a replaced image after commit', async () => {
    const { sourcePath } = setup()
    const organizationId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Image Studio'
    })

    await classificationImageService.setImage(
      { kind: 'organization', id: organizationId },
      { source: 'file', sourcePath }
    )
    const previousPath = storedImagePath('organizations', organizationId)
    assert.ok(previousPath?.startsWith('covers/'))
    assert.equal(fs.existsSync(mediaAssetStore.resolve(previousPath!)), true)

    const service = createClassificationImageService({
      fetchRemoteImage: async () => JPEG_1X1
    })
    const result = await service.setImage(
      { kind: 'organization', id: organizationId },
      { source: 'url', remoteUrl: 'https://example.com/logo.jpg' }
    )
    const nextPath = storedImagePath('organizations', organizationId)
    assert.ok(nextPath)
    assert.notEqual(nextPath, previousPath)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(previousPath!)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(nextPath!)), true)
    assert.deepEqual(result.cleanupFailures, [])
  })

  it('copies an associated video cover instead of adopting the video asset', async () => {
    const { sourcePath } = setup()
    const seriesId = classificationMaintenanceService.createSeries({ mainName: 'Cover Series' })
    const videoCover = mediaAssetStore.importCover('COVER-1', sourcePath)
    const videoId = Number(
      getDb()
        .prepare('INSERT INTO videos (code, cover_path, series_id, series) VALUES (?, ?, ?, ?)')
        .run('COVER-1', videoCover, seriesId, 'Cover Series').lastInsertRowid
    )

    await classificationImageService.setImage(
      { kind: 'series', id: seriesId },
      { source: 'video-cover', videoId }
    )

    const seriesCover = storedImagePath('series', seriesId)
    assert.ok(seriesCover)
    assert.notEqual(seriesCover, videoCover)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(videoCover)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(seriesCover!)), true)
    assert.deepEqual(classificationQueryService.listImageCandidates({ kind: 'series', id: seriesId }), [
      { videoId, code: 'COVER-1', title: null, coverPath: videoCover }
    ])

    const insertVideo = getDb().prepare(
      'INSERT INTO videos (code, cover_path, series_id, series) VALUES (?, ?, ?, ?)'
    )
    getDb().transaction(() => {
      for (let index = 2; index <= 101; index += 1) {
        insertVideo.run(`COVER-${index}`, videoCover, seriesId, 'Cover Series')
      }
    })()
    const candidates = classificationQueryService.listImageCandidates({
      kind: 'series',
      id: seriesId
    })
    assert.equal(candidates.length, 101)
    assert.equal(candidates.some((candidate) => candidate.videoId === videoId), true)

    await classificationImageService.setImage({ kind: 'series', id: seriesId }, null)
    assert.equal(storedImagePath('series', seriesId), null)
    assert.equal(classificationQueryService.getSeries(seriesId)?.fallbackCoverPath, videoCover)
    await assert.rejects(
      () =>
        classificationImageService.setImage(
          { kind: 'series', id: seriesId },
          { source: 'video-cover', videoId: Number.MAX_SAFE_INTEGER }
        ),
      /关联影片封面/
    )
  })

  it('stores a director portrait and compensates its replacement when the database update fails', async () => {
    const { sourcePath } = setup()
    const directorId = classificationMaintenanceService.createDirector({ mainName: 'Failed Director' })
    await classificationImageService.setImage(
      { kind: 'director', id: directorId },
      { source: 'file', sourcePath }
    )
    const previousPath = storedImagePath('directors', directorId)
    assert.ok(previousPath?.startsWith('avatars/'))
    assert.equal(fs.existsSync(mediaAssetStore.resolve(previousPath!)), true)

    getDb().exec(`CREATE TRIGGER fail_director_image BEFORE UPDATE OF image_path ON directors
      BEGIN SELECT RAISE(ABORT, 'forced image failure'); END`)
    const before = mediaAssetStore.listStoredImageAssetRels()

    await assert.rejects(
      () =>
        classificationImageService.setImage(
          { kind: 'director', id: directorId },
          { source: 'file', sourcePath }
        ),
      /forced image failure/
    )
    assert.equal(storedImagePath('directors', directorId), previousPath)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(previousPath!)), true)
    assert.deepEqual(mediaAssetStore.listStoredImageAssetRels(), before)
  })

  it('keeps the stored image when a remote download fails', async () => {
    const { sourcePath } = setup()
    const seriesId = classificationMaintenanceService.createSeries({ mainName: 'Remote Failure' })
    await classificationImageService.setImage(
      { kind: 'series', id: seriesId },
      { source: 'file', sourcePath }
    )
    const previousPath = storedImagePath('series', seriesId)
    const service = createClassificationImageService({
      fetchRemoteImage: async () => {
        throw new Error('download unavailable')
      }
    })

    await assert.rejects(
      () =>
        service.setImage(
          { kind: 'series', id: seriesId },
          { source: 'url', remoteUrl: 'https://example.com/missing.jpg' }
        ),
      /download unavailable/
    )
    assert.equal(storedImagePath('series', seriesId), previousPath)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(previousPath!)), true)

    await assert.rejects(
      () =>
        service.setImage(
          { kind: 'series', id: seriesId },
          { source: 'unsupported' } as never
        ),
      /来源参数无效/
    )
    assert.equal(storedImagePath('series', seriesId), previousPath)
  })

  it('commits replacement and reports a post-commit cleanup failure', async () => {
    const { sourcePath } = setup()
    const organizationId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Cleanup Studio'
    })
    await classificationImageService.setImage(
      { kind: 'organization', id: organizationId },
      { source: 'file', sourcePath }
    )
    const previousPath = storedImagePath('organizations', organizationId)
    const service = createClassificationImageService({
      deleteStoredImage: () => {
        throw new Error('asset locked')
      }
    })

    const result = await service.setImage({ kind: 'organization', id: organizationId }, null)

    assert.equal(storedImagePath('organizations', organizationId), null)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(previousPath!)), true)
    assert.deepEqual(result.cleanupFailures, [{ path: previousPath, error: 'asset locked' }])
  })
})
