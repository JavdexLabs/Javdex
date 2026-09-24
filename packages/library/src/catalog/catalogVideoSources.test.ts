import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { listCatalogVideoSources } from './catalogVideoSources'

it('pages unique videos for restricted source lookups and distinguishes empty match from invalid query', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-sources-'))
  try {
    const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
    db.exec(`
      INSERT INTO videos(id, code) VALUES (1,'ABC-001'),(2,'ABC-002'),(3,'XYZ-009');
      INSERT INTO video_sources(video_id, source, external_code, url)
      VALUES
        (1,'JavBus','ABC-001','https://www.javbus.com/abc-001'),
        (1,'Extra','ABC-001X','https://example.test/extra'),
        (2,'JavBus','abc-002','https://javbus.com/abc-002');
    `)
    const byIds = listCatalogVideoSources({ videoIds: [3, 1, 1, 9] })
    assert.deepEqual(
      byIds.items.map((item) => item.videoId),
      [1, 3]
    )
    assert.equal(byIds.items.find((item) => item.videoId === 3)?.sources.length, 0)
    assert.equal(byIds.items.find((item) => item.videoId === 1)?.sources.length, 2)

    const byCode = listCatalogVideoSources({ codes: ['abc-001'] })
    assert.deepEqual(byCode.items.map((item) => item.videoId), [1])

    const byExternal = listCatalogVideoSources({ source: 'javbus', externalCode: 'abc-002' })
    assert.deepEqual(byExternal.items.map((item) => item.videoId), [2])

    const byUrl = listCatalogVideoSources({
      source: 'JavBus',
      url: 'https://javbus.com/abc-001'
    })
    assert.deepEqual(byUrl.items.map((item) => item.videoId), [1])
    assert.equal(byUrl.total, 1)

    const missing = listCatalogVideoSources({ source: 'JavBus', externalCode: 'NOPE' })
    assert.deepEqual(missing, { items: [], total: 0, limit: 50, offset: 0 })

    try {
      listCatalogVideoSources({ limit: 50, offset: 0 })
      assert.fail('expected unrestricted query to fail')
    } catch (error) {
      assert.ok(isStructuredError(error))
      assert.equal(error.code, 'INVALID_INPUT')
    }
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
