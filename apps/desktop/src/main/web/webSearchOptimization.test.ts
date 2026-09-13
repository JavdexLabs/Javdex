import assert from 'node:assert/strict'
import { it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabaseAtPath, closeDatabase } from '@library/db/database'
import { WebCatalogQueryReader } from './catalogQueryReader'

it('preserves Web main-name-only literal search, filters, ordering and pagination', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-search-'))
  try {
    const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
    db.exec(`
      INSERT INTO media_libraries(id,name,icon,color,position,status,is_default,revision)
      VALUES(2,'Second','star','amber',1,'active',0,1),(3,'Archived','film','slate',2,'archived',0,1);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<90)
      INSERT INTO videos(id,code,title,rating,release_date)
      SELECT x,printf('CODE-%03d',x),'中文作品 '||x,x%5,'2025-01-01' FROM n;
      INSERT INTO library_video_memberships(library_id,video_id,discovery_key)
      SELECT 1,id,id FROM videos;
      UPDATE library_video_memberships SET is_hidden=1 WHERE video_id%7=0;
      INSERT INTO library_video_memberships(library_id,video_id,discovery_key,is_hidden)
      SELECT 2,id,id,CASE WHEN id%7=0 THEN 1 ELSE 0 END FROM videos WHERE id%2=0 AND id<89;
      INSERT INTO library_video_memberships(library_id,video_id,discovery_key)
      SELECT 3,id,id FROM videos WHERE id>=89;
      DELETE FROM library_video_memberships WHERE library_id=1 AND video_id>=89;
      DELETE FROM library_video_memberships WHERE video_id=89;
      INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(2,7,7);
      UPDATE library_video_memberships SET is_hidden=1 WHERE library_id=2 AND video_id=88;
      INSERT INTO actresses(id,main_name) VALUES(1,'演员_%\\'),(2,'ActorName'),(3,'無関連');
      INSERT INTO actress_names(actress_id,name,type,source) VALUES(2,'AliasOnly','alias','manual');
      INSERT INTO video_actress SELECT id,1 FROM videos WHERE id%2=0;
      INSERT INTO video_actress SELECT id,2 FROM videos WHERE id%3=0;
    `)
    const prepare = db.prepare.bind(db)
    let useOldQuery = false
    let oldQueries = 0
    t.mock.method(db, 'prepare', (sql: string) => {
      if (useOldQuery && sql.includes('WITH matched_actresses AS MATERIALIZED')) {
        const visibility = /v\.id IN \(\s*SELECT m\.video_id FROM library_video_memberships m[\s\S]*?l\.status = 'active'\s*\)/
        assert.ok(visibility.test(sql), 'must replace the actual visibility candidate predicate')
        sql = sql.replace(visibility,
          `EXISTS (SELECT 1 FROM library_video_memberships m
           JOIN media_libraries l ON l.id = m.library_id
           WHERE m.video_id = v.id AND m.is_hidden = 0 AND l.status = 'active')`)

        // Freeze the original correlated Web predicate as the differential oracle.
        sql = sql.replace(/v\.id IN \(\s*WITH matched_actresses AS MATERIALIZED \([\s\S]*?va\.actress_id = matched\.id\s*\)/,
          `EXISTS (SELECT 1 FROM video_actress va JOIN actresses a ON a.id = va.actress_id
           WHERE va.video_id = v.id AND a.main_name LIKE ? ESCAPE '\\')`)
        assert.ok(!sql.includes('WITH matched_actresses AS MATERIALIZED'))
        oldQueries++
      }
      return prepare(sql)
    })
    for (const library of [undefined, 1, 2, 3]) {
    for (const q of ['CODE-00', '中文', '演员', 'ActorName', 'actorname', 'AliasOnly', '%', '_', '\\', '無関連', '不存在', '  演员  ', '']) {
      for (const sort of ['recent', 'released', 'rating', 'code'] as const) {
        for (const page of [1, 2, 4]) {
          const input = { search: q, sort, page, library, year: 2025 }
          useOldQuery = true
          const expected = new WebCatalogQueryReader(db).browse(input)
          useOldQuery = false
          assert.deepEqual(new WebCatalogQueryReader(db).browse(input), expected, JSON.stringify(input))
          if (q === 'AliasOnly') assert.equal(expected.total, 0)
        }
      }
    }
    }
    assert.ok(oldQueries > 0)
    const reader = new WebCatalogQueryReader(db)
    assert.ok(reader.browse({ search: 'ActorName' }).total > 0)
    db.exec("UPDATE actresses SET main_name='Renamed' WHERE id=2")
    assert.equal(reader.browse({ search: 'ActorName' }).total, 0)
    assert.ok(reader.browse({ search: 'Renamed' }).total > 0)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
