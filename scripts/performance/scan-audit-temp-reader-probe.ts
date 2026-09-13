/** Decision probe: native readonly connection plus temporary derived data, never production configuration. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {initDatabaseAtPath,closeDatabase,openReadOnlyDatabaseAtPath} from '../../packages/library/src/db/database'
it('verifies native readonly protection while building connection-local TEMP data',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-temp-reader-'))
 try{
  const file=path.join(root,'catalog.db'),writer=initDatabaseAtPath(file)
  writer.exec("INSERT INTO tags(name) VALUES('source')")
  const schema=writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),version=writer.pragma('user_version',{simple:true})
  const reader=openReadOnlyDatabaseAtPath(file)
  try{
   assert.equal(reader.readonly,true)
   assert.throws(()=>reader.exec('CREATE TEMP TABLE derived(id INTEGER)'),/readonly|read-only/i)
   reader.pragma('query_only=OFF')
   reader.exec('CREATE TEMP TABLE derived AS SELECT id,name FROM main.tags')
   for(const sql of ["INSERT INTO main.tags(name) VALUES('forbidden')",'DELETE FROM main.tags','CREATE TABLE main.forbidden(id)','PRAGMA main.user_version=0']){
    assert.throws(()=>reader.exec(sql),/readonly|read-only/i)
   }
   reader.pragma('query_only=ON')
   assert.deepEqual(reader.prepare('SELECT name FROM temp.derived').all(),[{name:'source'}])
   assert.throws(()=>reader.exec('DELETE FROM temp.derived'),/readonly|read-only/i)
  }finally{reader.close()}
  const reopened=openReadOnlyDatabaseAtPath(file)
  try{assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name='derived'").get() as {n:number}).n,0)}finally{reopened.close()}
  assert.deepEqual(writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),schema)
  assert.equal(writer.pragma('user_version',{simple:true}),version)
  assert.deepEqual(writer.prepare('SELECT name FROM tags').all(),[{name:'source'}])
  console.log(JSON.stringify({nativeReadonlyPreserved:true,tempBuildWithQueryOnlyOff:true,tempReadWithQueryOnlyOn:true,tempRemovedOnClose:true,productionConfigurationChanged:false}))
 }finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
