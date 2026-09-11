import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from './database'
import { iterateSourceManagedVideoResourceRefs, listSourceManagedVideoResourceRefs } from './videoRepo'

it('iterates source-managed resources in order while deleting, with bounded reads and rollback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-source-iteration-'))
  try {
    const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
    db.exec(`INSERT INTO videos(id,code) VALUES(1,'ITERATION');
      INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(1,1,1);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1100)
      INSERT INTO video_resources(id,library_id,video_id,kind,locator,resource_key,source_identity,strm_source_path)
      SELECT x,1,1,CASE WHEN x%3=0 THEN 'local' ELSE 'web' END,'path/'||x,'key/'||x,
        CASE WHEN x%3!=1 THEN 'identity/'||x END, CASE WHEN x%3=2 THEN 'strm/'||x END FROM n;`)
    db.exec(`INSERT INTO media_libraries(id,name) VALUES(2,'Other');
      INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(2,1,2);
      UPDATE video_resources SET library_id=2 WHERE id%10=0;`)
    const expected = listSourceManagedVideoResourceRefs(1)
    assert.throws(() => [...iterateSourceManagedVideoResourceRefs(1)], /requires a transaction/)
    const prepare = db.prepare.bind(db), sizes: number[] = [], plans: unknown[] = []
    db.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (sql.includes('ORDER BY id LIMIT 256')) {
        plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all(1,0,1100))
        const all = statement.all.bind(statement)
        statement.all = ((...args: unknown[]) => {
          const rows = all(...args); sizes.push(rows.length); return rows
        }) as typeof statement.all
      }
      return statement
    }) as typeof db.prepare
    try {
      assert.throws(db.transaction(() => {
        const actual = []
        for (const ref of iterateSourceManagedVideoResourceRefs(1)) {
          actual.push(ref)
          db.prepare('DELETE FROM video_resources WHERE id = ?').run(ref.resource_id)
        }
        assert.deepEqual(actual, expected)
        assert.ok(sizes.length >= 3)
        assert.ok(sizes.every(size => size <= 256))
        throw new Error('rollback cleanup')
      }), /rollback cleanup/)
      assert.deepEqual(listSourceManagedVideoResourceRefs(1), expected)
      db.transaction(() => {
        const iterator = iterateSourceManagedVideoResourceRefs(1)
        const first = iterator.next()
        db.exec(`INSERT INTO video_resources(id,library_id,video_id,kind,locator,resource_key,source_identity)
          VALUES(2000,1,1,'local','new-path','new-key','new-identity')`)
        assert.deepEqual([first.value, ...iterator], expected)
      })()
      assert.equal(listSourceManagedVideoResourceRefs(2).length > 0, true)
      assert.deepEqual(db.transaction(() => [...iterateSourceManagedVideoResourceRefs(999)])(), [])
      const details = JSON.stringify(plans)
      assert.match(details, /INTEGER PRIMARY KEY/)
      assert.doesNotMatch(details, /TEMP B-TREE/)
      console.log(JSON.stringify({sourceIterationPlans: plans}))
    } finally { db.prepare = prepare }
  } finally { closeDatabase(); fs.rmSync(root, {recursive:true,force:true}) }
})
