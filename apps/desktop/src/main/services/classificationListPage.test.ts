import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getDb, initDatabaseAtPath, closeDatabase } from '../db/database'
import { classificationMaintenanceService as write } from './classificationMaintenanceService'
import { classificationQueryService as read } from './classificationQueryService'
import { appIpcSchemas } from '../ipc/ipcCommandSchemas'
import { IPC } from '@shared/ipc-channels'
let root: string
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-classification-page-'));initDatabaseAtPath(path.join(root,'catalog.db'))})
afterEach(()=>{closeDatabase();fs.rmSync(root,{recursive:true,force:true})})

it('matches every old list field and global ordering over pages, aliases, roles and cover boundaries',()=>{
  const db=getDb()
  for(let n=0;n<125;n++) {
    const org=write.createOrganization({role:'maker',mainName:`Org-${n}`,aliases:[n===2?'literal%_\\':`Alias-${n}`]})
    if(n%2===0) db.prepare("INSERT INTO organization_roles(organization_id,role) VALUES(?,'publisher')").run(org)
    const director=write.createDirector({mainName:`Director-${n}`,aliases:[n===2?'literal%_\\':`Alias-${n}`]})
    const series=write.createSeries({mainName:`Series-${n}`,ownerOrganizationId:n%3===0?org:null,aliases:[n===2?'literal%_\\':`Alias-${n}`]})
    for(let v=0;v<n%4;v++) db.prepare(`INSERT INTO videos(code,maker_organization_id,publisher_organization_id,series_id,director_id,release_date,add_time,cover_path)
      VALUES(?,?,?,?,?,?,?,?)`).run(`CODE-${n}-${v}`,org,n%2===0?org:null,series,director,v===1?null:'2020-01-01','2021-01-01',[null,'','cover.jpg'][v%3])
    db.prepare('UPDATE organizations SET updated_at=? WHERE id=?').run(n%2?'2024-01-01':'2020-01-01',org)
    db.prepare('UPDATE directors SET updated_at=? WHERE id=?').run(n%2?'2024-01-01':'2020-01-01',director)
    db.prepare('UPDATE series SET updated_at=? WHERE id=?').run(n%2?'2024-01-01':'2020-01-01',series)
  }
  for(const sortBy of ['video_count','updated_at'] as const) for(const sortDir of ['asc','desc'] as const) {
    for(const search of ['', 'alias', '%_', 'missing']) {
      const query={sortBy,sortDir,search}
      const expectedDirectors=read.listDirectors(query),actualDirectors=[]
      for(let offset=0;offset<=expectedDirectors.length;offset+=60){const page=read.listDirectorsPage({...query,offset});assert.equal(page.total,expectedDirectors.length);assert.ok(page.items.length<=60);actualDirectors.push(...page.items)}
      assert.deepEqual(actualDirectors,expectedDirectors)
      const expectedSeries=read.listSeries(query),actualSeries=[]
      for(let offset=0;offset<=expectedSeries.length;offset+=60){const page=read.listSeriesPage({...query,offset});assert.equal(page.total,expectedSeries.length);assert.ok(page.items.length<=60);actualSeries.push(...page.items)}
      assert.deepEqual(actualSeries,expectedSeries)
      for(const role of ['maker','publisher'] as const) {
        const expected=read.listOrganizations({...query,role}),actual=[]
        for(let offset=0;offset<=expected.length;offset+=60){const page=read.listOrganizationsPage({...query,role,offset});assert.equal(page.total,expected.length);assert.ok(page.items.length<=60);actual.push(...page.items)}
        assert.deepEqual(actual,expected)
      }
    }
  }
})

it('keeps count and page in one read snapshot across another connection changing the role',()=>{
  const org=write.createOrganization({role:'maker',mainName:'Snapshot'})
  const db=getDb(),other=new Database(path.join(root,'catalog.db')),prepare=db.prepare.bind(db)
  let fired=false
  db.prepare=((sql:string)=>{
    const statement=prepare(sql)
    if(sql.startsWith('SELECT COUNT(*) AS n FROM organizations')) {
      const get=statement.get.bind(statement)
      statement.get=((...args:unknown[])=>{const result=get(...args);if(!fired){fired=true;other.prepare("DELETE FROM organization_roles WHERE organization_id=? AND role='maker'").run(org)}return result}) as typeof statement.get
    }
    return statement
  }) as typeof db.prepare
  try {const page=read.listOrganizationsPage({role:'maker'});assert.equal(page.total,1);assert.deepEqual(page.items.map(i=>i.id),[org]);assert.equal(read.listOrganizationsPage({role:'maker'}).total,0)}
  finally {db.prepare=prepare;other.close()}
})

it('validates page boundaries in the service and typed IPC without changing complete-list APIs',()=>{
  for(const query of [{limit:0},{limit:101},{offset:-1},{offset:0.5},{offset:Infinity},{offset:Number.MAX_SAFE_INTEGER+1}]) {
    assert.throws(()=>read.listDirectorsPage(query));
    assert.equal(appIpcSchemas[IPC.DIRECTOR_PAGE].safeParse([query]).success,false)
    assert.throws(()=>read.listSeriesPage(query));assert.throws(()=>read.listOrganizationsPage({...query,role:'maker'}))
    assert.equal(appIpcSchemas[IPC.SERIES_PAGE].safeParse([query]).success,false)
    assert.equal(appIpcSchemas[IPC.ORGANIZATION_PAGE].safeParse([{...query,role:'maker'}]).success,false)
  }
  assert.equal(appIpcSchemas[IPC.DIRECTOR_PAGE].safeParse([{limit:100,offset:60}]).success,true)
  assert.equal(appIpcSchemas[IPC.DIRECTOR_PAGE].safeParse([{role:'maker'}]).success,false)
  assert.deepEqual(read.listDirectorsPage({}),{items:[],total:0,limit:60,offset:0})
  assert.deepEqual(read.listSeriesPage({}),{items:[],total:0,limit:60,offset:0})
  assert.equal(appIpcSchemas[IPC.SERIES_PAGE].safeParse([{limit:100,offset:120,sortBy:'updated_at',sortDir:'asc'}]).success,true)
  assert.equal(appIpcSchemas[IPC.ORGANIZATION_PAGE].safeParse([{role:'maker'}]).success,true)
  for(const query of [{role:'bad'},{role:'maker',full:true},{search:1}]) assert.equal(appIpcSchemas[IPC.ORGANIZATION_PAGE].safeParse([query]).success,false)
})
