import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { getVideoById } from '../db/videoRepo'
import { classificationQueryService } from './classificationQueryService'
import { classificationMaintenanceService } from './classificationMaintenanceService'

function withDatabase(run: () => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-organizations-'))
  try {
    initDatabaseAtPath(path.join(tempDir, 'library.db'))
    run()
  } finally {
    closeDatabase()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function insertVideo(code: string, releaseDate: string, coverPath: string | null = null): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO videos (code, release_date, cover_path)
         VALUES (?, ?, ?)`
      )
      .run(code, releaseDate, coverPath).lastInsertRowid
  )
}

describe('classification organization query and maintenance services', () => {
  it('shares one organization profile across role lists and searches its aliases', () => {
    withDatabase(() => {
      const organizationId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Studio One',
        aliases: ['Ｓ １'],
        summary: 'Independent studio',
        countryRegion: 'JP',
        foundedYear: 2001,
        status: 'active',
        links: [{ label: 'Official', url: 'https://example.com/studio' }]
      })
      const firstVideoId = insertVideo('ORG-001', '2023-01-02', 'covers/one.jpg')
      const secondVideoId = insertVideo('ORG-002', '2024-03-04')
      classificationMaintenanceService.assignVideoOrganization(firstVideoId, 'maker', {
        organizationId
      })
      classificationMaintenanceService.assignVideoOrganization(secondVideoId, 'publisher', {
        organizationId
      })

      assert.deepEqual(
        classificationQueryService
          .listOrganizations({ role: 'maker', search: 's 1' })
          .map((item) => ({ id: item.id, name: item.mainName, count: item.videoCount })),
        [{ id: organizationId, name: 'Studio One', count: 1 }]
      )
      assert.deepEqual(
        classificationQueryService
          .listOrganizations({ role: 'publisher' })
          .map((item) => ({ id: item.id, name: item.mainName, count: item.videoCount })),
        [{ id: organizationId, name: 'Studio One', count: 1 }]
      )

      const detail = classificationQueryService.getOrganization(organizationId, 'maker')
      assert.deepEqual(
        detail && {
          id: detail.id,
          mainName: detail.mainName,
          aliases: detail.aliases,
          summary: detail.summary,
          countryRegion: detail.countryRegion,
          foundedYear: detail.foundedYear,
          status: detail.status,
          roles: detail.roles,
          link: detail.links[0],
          videoCount: detail.videoCount,
          releaseYearStart: detail.releaseYearStart,
          releaseYearEnd: detail.releaseYearEnd,
          fallbackCoverPath: detail.fallbackCoverPath
        },
        {
          id: organizationId,
          mainName: 'Studio One',
          aliases: ['Ｓ １'],
          summary: 'Independent studio',
          countryRegion: 'JP',
          foundedYear: 2001,
          status: 'active',
          roles: ['maker', 'publisher'],
          link: { label: 'Official', url: 'https://example.com/studio', position: 0 },
          videoCount: 1,
          releaseYearStart: 2023,
          releaseYearEnd: 2023,
          fallbackCoverPath: 'covers/one.jpg'
        }
      )
    })
  })

  it('sorts only by video count or update time in either direction', () => {
    withDatabase(() => {
      const olderId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Older'
      })
      const newerId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Newer'
      })
      const firstVideoId = insertVideo('SORT-1', '2020-01-01')
      const secondVideoId = insertVideo('SORT-2', '2021-01-01')
      classificationMaintenanceService.assignVideoOrganization(firstVideoId, 'maker', {
        organizationId: olderId
      })
      classificationMaintenanceService.assignVideoOrganization(secondVideoId, 'maker', {
        organizationId: olderId
      })
      getDb()
        .prepare('UPDATE organizations SET updated_at = ? WHERE id = ?')
        .run('2020-01-01T00:00:00.000Z', olderId)
      getDb()
        .prepare('UPDATE organizations SET updated_at = ? WHERE id = ?')
        .run('2025-01-01T00:00:00.000Z', newerId)

      assert.deepEqual(
        classificationQueryService
          .listOrganizations({ role: 'maker', sortBy: 'video_count', sortDir: 'desc' })
          .map((item) => item.id),
        [olderId, newerId]
      )
      assert.deepEqual(
        classificationQueryService
          .listOrganizations({ role: 'maker', sortBy: 'video_count', sortDir: 'asc' })
          .map((item) => item.id),
        [newerId, olderId]
      )
      assert.deepEqual(
        classificationQueryService
          .listOrganizations({ role: 'maker', sortBy: 'updated_at', sortDir: 'desc' })
          .map((item) => item.id),
        [newerId, olderId]
      )
    })
  })

  it('treats SQL LIKE metacharacters in organization searches as literal text', () => {
    withDatabase(() => {
      const percentId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Studio % One'
      })
      const underscoreId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Alias Holder',
        aliases: ['Under_score']
      })
      classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Ordinary Studio'
      })

      assert.deepEqual(
        classificationQueryService
          .listOrganizations({ role: 'maker', search: '%' })
          .map((item) => item.id),
        [percentId]
      )
      assert.deepEqual(
        classificationQueryService.listOrganizationOptions('_').map((item) => item.id),
        [underscoreId]
      )
    })
  })

  it('keeps stable identity and video links when editing the complete profile', () => {
    withDatabase(() => {
      const parentId = classificationMaintenanceService.createOrganization({
        role: 'publisher',
        mainName: 'Parent'
      })
      const organizationId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Before'
      })
      const videoId = insertVideo('RENAME-1', '2022-01-01')
      classificationMaintenanceService.assignVideoOrganization(videoId, 'maker', {
        organizationId
      })

      classificationMaintenanceService.updateOrganization(organizationId, {
        mainName: 'After',
        keepPreviousMainName: true,
        aliases: ['Alias'],
        summary: 'Updated\nprofile',
        countryRegion: 'US',
        foundedYear: 1999,
        endedYear: 2024,
        status: 'inactive',
        parentOrganizationId: parentId,
        links: [
          { label: 'Official', url: 'https://example.com/after' },
          { label: 'Wiki', url: 'https://example.com/wiki' }
        ]
      })

      const detail = classificationQueryService.getOrganization(organizationId, 'maker')
      assert.equal(detail?.mainName, 'After')
      assert.deepEqual(detail?.aliases, ['Before', 'Alias'])
      assert.equal(detail?.parent?.id, parentId)
      assert.equal(detail?.summary, 'Updated\nprofile')
      assert.equal(detail?.endedYear, 2024)
      assert.equal(detail?.links.length, 2)
      assert.deepEqual(
        {
          organizationId: getVideoById(videoId)?.maker_organization_id,
          maker: getVideoById(videoId)?.maker
        },
        { organizationId, maker: 'After' }
      )
    })
  })

  it('rejects parent cycles without partially changing the profile', () => {
    withDatabase(() => {
      const parentId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Parent'
      })
      const childId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'Child',
        parentOrganizationId: parentId
      })

      assert.throws(
        () =>
          classificationMaintenanceService.updateOrganization(parentId, {
            mainName: 'Changed',
            aliases: [],
            links: [],
            parentOrganizationId: childId
          }),
        /循环/
      )
      assert.equal(classificationQueryService.getOrganization(parentId, 'maker')?.mainName, 'Parent')
      assert.equal(classificationQueryService.getOrganization(childId, 'maker')?.parent?.id, parentId)
    })
  })

  it('creates an organization inline, registers the role, and retains zero-video roles', () => {
    withDatabase(() => {
      const videoId = insertVideo('INLINE-1', '2024-01-01')
      const assigned = classificationMaintenanceService.assignVideoOrganization(videoId, 'publisher', {
        createName: 'Inline Publisher'
      })
      assert.equal(assigned.mainName, 'Inline Publisher')
      assert.ok(assigned.organizationId)

      classificationMaintenanceService.assignVideoOrganization(videoId, 'publisher', null)
      assert.deepEqual(
        classificationQueryService
          .listOrganizations({ role: 'publisher' })
          .map((item) => ({ id: item.id, count: item.videoCount })),
        [{ id: assigned.organizationId, count: 0 }]
      )
    })
  })

  it('rolls back profile fields when a name is owned by another organization', () => {
    withDatabase(() => {
      const firstId = classificationMaintenanceService.createOrganization({
        role: 'maker',
        mainName: 'First'
      })
      classificationMaintenanceService.createOrganization({
        role: 'publisher',
        mainName: 'Taken Name'
      })

      assert.throws(
        () =>
          classificationMaintenanceService.updateOrganization(firstId, {
            mainName: 'Still First',
            aliases: ['ＴＡＫＥＮ　ＮＡＭＥ'],
            summary: 'must rollback',
            links: []
          }),
        /已归属于其他机构/
      )
      const detail = classificationQueryService.getOrganization(firstId, 'maker')
      assert.equal(detail?.mainName, 'First')
      assert.equal(detail?.summary, null)
    })
  })
})
