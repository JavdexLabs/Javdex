import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { insertTestVideoWithFile } from './testVideoFixtures'
import { getTagLabels, listTagFilterOptions, listManualTagOptions, listManualTags, listTags, pruneUnusedTags } from './tagRepo'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-tag-repo-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  insertTestVideoWithFile(db, { code: 'ABC-1', filePath: 'a.mp4', scrapedStatus: 0 })
  db.prepare("INSERT INTO tags (id, name) VALUES (1, 'Linked'), (2, 'Orphan')").run()
  db.prepare('INSERT INTO video_tag (video_id, tag_id) VALUES (1, 1)').run()
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('tagRepo.pruneUnusedTags', () => {
  it('deletes tags with no video links and keeps tags still used by a video', () => {
    setupDb()
    const db = getDb()

    assert.equal(pruneUnusedTags(), 1)
    assert.deepEqual(db.prepare('SELECT name FROM tags WHERE id = 1').get(), { name: 'Linked' })
    assert.equal(db.prepare('SELECT id FROM tags WHERE id = 2').get(), undefined)
    assert.equal(pruneUnusedTags(), 0)
  })
})

describe('tagRepo selected labels', () => {
  it('looks up only selected IDs through the tag primary key and omits deleted IDs', (t) => {
    setupDb()
    const db = getDb()
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(3) UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO tags(id,name) SELECT x,'Unselected '||x FROM n`)
    const prepare = db.prepare.bind(db)
    const statements: string[] = []
    t.mock.method(db, 'prepare', (sql: string) => { statements.push(sql); return prepare(sql) })
    assert.deepEqual(getTagLabels([2, 1, 2, 20000]), [{ id: 1, label: 'Linked' }, { id: 2, label: 'Orphan' }])
    assert.equal(statements.length, 1)
    assert.doesNotMatch(statements[0], /video_tag|membership|COUNT\(/i)
    const plan = prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all(2, 1, 20000) as Array<{ detail: string }>
    assert.ok(plan.some(row => /SEARCH tags USING INTEGER PRIMARY KEY/.test(row.detail)))
    assert.ok(plan.every(row => !/SCAN tags/.test(row.detail)))
  })

  it('bounds display labels and JSON bytes without changing full stored names', () => {
    setupDb()
    const db = getDb()
    const insert = db.prepare('INSERT INTO tags(id,name) VALUES (?,?)')
    const ids = Array.from({ length: 100 }, (_, index) => index + 3)
    db.transaction(() => { for (const id of ids) insert.run(id, '\u0001'.repeat(2048) + id) })()
    const labels = getTagLabels(ids)
    assert.equal(labels.length, 100)
    assert.ok(labels.every(row => row.label === '\u0001'.repeat(128) + '…'))
    assert.ok(Buffer.byteLength(JSON.stringify(labels)) < 96 * 1024)
    assert.equal((db.prepare('SELECT name FROM tags WHERE id=3').get() as { name: string }).name, '\u0001'.repeat(2048) + '3')
    db.prepare('UPDATE tags SET name=? WHERE id=3').run('😀'.repeat(129))
    assert.equal(getTagLabels([3])[0].label, '😀'.repeat(128) + '…')
  })

  it('rejects invalid or oversized requests and does no SQL work for an empty selection', (t) => {
    setupDb()
    const prepare = t.mock.method(getDb(), 'prepare', () => { throw new Error('unexpected query') })
    assert.deepEqual(getTagLabels([]), [])
    for (const ids of [[0], [-1], [1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1], Array(101).fill(1)]) {
      assert.throws(() => getTagLabels(ids), /最多接受100个有效ID/)
    }
    assert.equal(prepare.mock.callCount(), 0)
  })
})

describe('tagRepo manual candidates', () => {
  it('pages alphabetically without counts and retains hidden/manual-only associations', () => {
    setupDb()
    const db = getDb()
    const insert = db.prepare('INSERT INTO tags(id,name) VALUES (?,?)')
    db.transaction(() => {
      for (let i = 0; i < 205; i++) {
        insert.run(i + 3, `T${String(i).padStart(3, '0')}`)
        db.prepare("INSERT INTO video_tag(video_id,tag_id,origin) VALUES (1,?,'manual')").run(i + 3)
      }
      insert.run(999, 'Scraped only')
      db.exec("INSERT INTO video_tag(video_id,tag_id,origin) VALUES (1,999,'scraped'); UPDATE library_video_memberships SET is_hidden=1")
    })()
    const expected = db.prepare('SELECT id,name AS label FROM tags WHERE id=1 OR id BETWEEN 3 AND 207 ORDER BY name').all()
    for (const maintain of [() => {}, () => db.exec('ANALYZE')]) {
      maintain()
      const pages = [0, 100, 200].map(offset => listManualTagOptions({ offset }))
      assert.deepEqual(pages.map(page => page.items.length), [100, 100, 6])
      assert.deepEqual(pages.map(page => page.hasMore), [true, true, false])
      assert.deepEqual(pages.flatMap(page => page.items), expected)
      assert.deepEqual(listManualTagOptions({ offset: 300 }), { items: [], hasMore: false })
    }
    db.transaction(() => {
      for (let i = 3; i <= 207; i++) db.prepare('UPDATE tags SET name=? WHERE id=?').run('\u0001'.repeat(2048) + i, i)
    })()
    const bounded = listManualTagOptions({})
    assert.equal(bounded.items.length, 100)
    assert.equal(bounded.hasMore, true)
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 96 * 1024)
    assert.ok(bounded.items.every(tag => tag.label === '\u0001'.repeat(128) + '…'))
  })

  it('preserves Unicode/literal substring matching and searches beyond display truncation', () => {
    setupDb()
    const db = getDb()
    const names = ['École', 'İZMİR', 'Straße', '50%_sale', "it's", '😀'.repeat(200) + 'Needle', 'İ'.repeat(500)]
    db.transaction(() => names.forEach((name, index) => {
      db.prepare('INSERT INTO tags(id,name) VALUES (?,?)').run(index + 3, name)
      db.prepare("INSERT INTO video_tag(video_id,tag_id,origin) VALUES (1,?,'manual')").run(index + 3)
    }))()
    for (const search of ['éCO', 'i', 'İZ', 'izmir', 'STRASSE', '%_', "it's", 'needle', '  linked  ', 'absent', 'İ'.repeat(500)]) {
      const expectedIds = [{ id: 1, name: 'Linked' }, ...names.map((name, i) => ({ id: i + 3, name }))]
        .filter(tag => tag.name.toLowerCase().includes(search.trim().toLowerCase())).map(tag => tag.id).sort((a, b) => a - b)
      assert.deepEqual(listManualTagOptions({ search }).items.map(tag => tag.id).sort((a, b) => a - b), expectedIds)
    }
    assert.equal(listManualTagOptions({ search: 'needle' }).items[0].label, '😀'.repeat(128) + '…')
  })

  it('uses tag-key existence checks under skewed statistics and validates its work limits', (t) => {
    setupDb()
    const db = getDb()
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(3) UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO tags(id,name) SELECT x,'Unlinked '||x FROM n; ANALYZE`)
    const prepare = db.prepare.bind(db)
    let sql = ''
    t.mock.method(db, 'prepare', (query: string) => { sql = query; return prepare(query) })
    assert.equal(listManualTagOptions({}).items.length, 1)
    assert.doesNotMatch(sql, /COUNT\(|library_video|GROUP BY/i)
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(101, 0) as Array<{ detail: string }>
    assert.ok(plan.some(row => /idx_video_tag_tag_id/.test(row.detail)))
    for (const query of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }, { search: 'x'.repeat(501) }]) {
      assert.throws(() => listManualTagOptions(query), /无效的标签候选/)
    }
  })
})

describe('tagRepo active catalog projection', () => {
  it('matches manual association and visibility semantics before and after statistics maintenance', () => {
    setupDb()
    const db = getDb()
    db.exec(`
      INSERT INTO media_libraries (id, name, status) VALUES
        (2, 'Shared', 'active'), (3, 'Archived', 'archived');
      INSERT INTO tags (id, name) VALUES (3, 'Mixed'), (4, 'Hidden manual'), (5, 'Scraped only');
    `)
    for (let i = 2; i <= 80; i++) {
      insertTestVideoWithFile(db, { code: `MIX-${i}`, filePath: `${i}.mp4`, scrapedStatus: 0 })
    }
    db.exec(`
      UPDATE library_video_memberships SET is_hidden = (video_id % 3 = 0);
      INSERT INTO library_video_memberships (library_id, video_id, added_at, updated_at, added_via, discovery_key)
        SELECT 2, id, '2026', '2026', 'shared', id FROM videos WHERE id % 4 = 0;
      INSERT INTO library_video_memberships (library_id, video_id, added_at, updated_at, added_via, discovery_key)
        SELECT 3, id, '2026', '2026', 'shared', id FROM videos;
      INSERT INTO video_tag (video_id, tag_id, origin)
        SELECT id, 3, CASE WHEN id % 2 = 0 THEN 'manual' ELSE 'scraped' END FROM videos;
      INSERT INTO video_tag (video_id, tag_id, origin) VALUES
        (3, 4, 'manual'), (2, 4, 'scraped'), (2, 5, 'scraped');
    `)
    const expected = (manualOnly: boolean) => db.prepare(`
      SELECT t.*, (
        SELECT COUNT(*) FROM video_tag vt
        WHERE vt.tag_id = t.id ${manualOnly ? "AND vt.origin = 'manual'" : ''}
          AND EXISTS (
            SELECT 1 FROM library_video_memberships m JOIN media_libraries l ON l.id = m.library_id
            WHERE m.video_id = vt.video_id AND m.is_hidden = 0 AND l.status = 'active'
          )
      ) AS video_count FROM tags t
      ${manualOnly ? "WHERE EXISTS (SELECT 1 FROM video_tag vt WHERE vt.tag_id = t.id AND vt.origin = 'manual')" : ''}
      ORDER BY video_count DESC, t.name
    `).all()
    const all = expected(false)
    const manual = expected(true)
    for (const maintain of [() => {}, () => db.pragma('optimize = 0x10012'), () => db.exec('ANALYZE')]) {
      maintain()
      assert.deepEqual(listTags(), all)
      assert.deepEqual(listManualTags(), manual)
      assert.equal(listManualTags().find(tag => tag.id === 4)?.video_count, 0)
      assert.equal(listManualTags().some(tag => tag.id === 5), false)
    }
  })

  it('deduplicates shared memberships and preserves manual origin and zero-count tags', () => {
    setupDb()
    const db = getDb()
    db.exec(`
      UPDATE video_tag SET origin = 'scraped' WHERE tag_id = 1;
      INSERT INTO media_libraries (id, name, status) VALUES (2, 'Shared', 'active');
      INSERT INTO library_video_memberships (library_id, video_id, added_at, updated_at, added_via, discovery_key) VALUES (2, 1, '2026', '2026', 'shared', 1);
      INSERT INTO tags (id, name) VALUES (3, 'Manual');
      INSERT INTO video_tag (video_id, tag_id, origin) VALUES (1, 3, 'manual');
    `)
    assert.deepEqual(listTags().map(t => [t.id, t.video_count]), [[1, 1], [3, 1], [2, 0]])
    assert.deepEqual(listManualTags().map(t => [t.id, t.video_count]), [[3, 1]])
    db.exec("UPDATE media_libraries SET status = 'archived' WHERE id = 2; UPDATE library_video_memberships SET is_hidden = 1 WHERE library_id = 1")
    assert.deepEqual(listManualTags().map(t => [t.id, t.video_count]), [[3, 0]])
    assert.equal(listTags().every(t => t.video_count === 0), true)
  })

  it('counts only videos that can be opened through the active visible catalog', () => {
    setupDb()
    const db = getDb()
    db.prepare("UPDATE video_tag SET origin = 'manual' WHERE video_id = 1 AND tag_id = 1").run()

    assert.equal(listTags().find((tag) => tag.id === 1)?.video_count, 1)
    assert.equal(listManualTags().find((tag) => tag.id === 1)?.video_count, 1)

    db.prepare('UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = 1').run()
    assert.equal(listTags().find((tag) => tag.id === 1)?.video_count, 0)
    assert.equal(listManualTags().find((tag) => tag.id === 1)?.video_count, 0)
  })
})


describe('tagRepo filter candidates', () => {
  it('paginates names before counts and matches global visibility counts with shared and archived members', () => {
    setupDb()
    const db = getDb()
    db.exec(`INSERT INTO media_libraries(id,name,status) VALUES(2,'Shared','active'),(3,'Archived','archived');
      INSERT INTO library_video_memberships(library_id,video_id,added_at,discovery_key)
        VALUES(2,1,'now',1),(3,1,'now',1);
      WITH RECURSIVE n(x) AS (VALUES(3) UNION ALL SELECT x+1 FROM n WHERE x<206)
      INSERT INTO tags(id,name) SELECT x,printf('Tag %03d',x) FROM n;
      INSERT INTO video_tag(video_id,tag_id,origin) VALUES(1,3,'scraped'),(1,206,'manual');`)
    for (const stage of ['initial', 'analyzed', 'hidden']) {
      if (stage === 'analyzed') db.exec('ANALYZE')
      if (stage === 'hidden') db.exec('UPDATE library_video_memberships SET is_hidden=1 WHERE library_id IN (1,2)')
      const expected = listTags().sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id-b.id)
        .map(({ id, name, video_count }) => ({ id, label: name, video_count }))
      const pages = [0,100,200].map(offset => listTagFilterOptions({ offset }))
      assert.deepEqual(pages.map(page => page.items.length), [100,100,6])
      assert.deepEqual(pages.map(page => page.hasMore), [true,true,false])
      assert.deepEqual(pages.flatMap(page => page.items), expected)
    }
  })

  it('keeps Unicode literal search, bounded labels and page-only count parameters', (t) => {
    setupDb()
    const db = getDb()
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(4) UNION ALL SELECT x+1 FROM n WHERE x<10004)
      INSERT INTO tags(id,name) SELECT x,'Unrelated '||x FROM n;
      INSERT INTO video_tag(video_id,tag_id) SELECT 1,id FROM tags WHERE id>=4;`)
    const name = 'ÉCOLE_%' + '😀'.repeat(200) + 'Needle'
    db.prepare('INSERT INTO tags(id,name) VALUES(3,?)').run(name)
    const trace: { sql: string; params: unknown[] }[] = []
    const prepare = db.prepare.bind(db)
    t.mock.method(db, 'prepare', (sql: string) => {
      const statement = prepare(sql)
      const all = statement.all.bind(statement)
      statement.all = ((...params: unknown[]) => { trace.push({ sql, params }); return all(...params) }) as typeof statement.all
      return statement
    })
    const page = listTagFilterOptions({ search: 'école_%', limit: 1 })
    assert.deepEqual(page.items, [{ id:3, label: Array.from(name).slice(0,128).join('') + '…', video_count:0 }])
    assert.deepEqual(trace.find(entry => entry.sql.includes('FROM video_tag'))?.params, [3])
    assert.equal(listTagFilterOptions({ search: 'Needle' }).items[0]?.id, 3)
    trace.length = 0
    assert.deepEqual(listTagFilterOptions({ search: 'absent' }), { items: [], hasMore: false })
    assert.equal(trace.length, 1, 'empty page must not query associations')
    trace.length = 0
    for (const query of [{ limit:101 },{ limit:0 },{ offset:-1 },{ search:'x'.repeat(501) }]) {
      assert.throws(() => listTagFilterOptions(query))
    }
    assert.equal(trace.length,0)
    for (const maintain of [() => {}, () => db.exec('ANALYZE')]) {
      maintain()
      trace.length = 0
      listTagFilterOptions({ search: 'école_%', limit: 1 })
      const countQuery = trace.find(entry => entry.sql.includes('FROM video_tag'))!
      const plan = prepare(`EXPLAIN QUERY PLAN ${countQuery.sql}`).all(...countQuery.params) as { detail: string }[]
      assert.ok(plan.some(row => /SEARCH vt USING INDEX idx_video_tag_tag_id \(tag_id=\?\)/.test(row.detail)), JSON.stringify(plan))
      assert.ok(!plan.some(row => /SCAN vt/.test(row.detail)))
    }
  })
})
