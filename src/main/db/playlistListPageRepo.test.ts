import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabaseAtPath, closeDatabase } from './database'
import { listPlaylistBrowsePage } from './playlistListPageRepo'
import { listPlaylists, listPlaylistsForVideo } from './playlistRepo'
import { insertTestVideoWithFile } from './testVideoFixtures'
import { IPC } from '@shared/ipc-channels'
import { appIpcSchemas } from '../ipc/ipcCommandSchemas'

let root:string,previous:string|undefined
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-playlist-list-'));previous=process.env.JAVDEX_TEST_USER_DATA;process.env.JAVDEX_TEST_USER_DATA=root})
afterEach(()=>{closeDatabase();if(previous===undefined)delete process.env.JAVDEX_TEST_USER_DATA;else process.env.JAVDEX_TEST_USER_DATA=previous;fs.rmSync(root,{recursive:true,force:true})})
function setup() {
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  insertTestVideoWithFile(db,{code:'PL-1',filePath:'/synthetic/1.mp4'})
  db.exec("UPDATE videos SET cover_path='covers/1.png'; UPDATE library_video_memberships SET is_hidden=1")
  const insert=db.prepare('INSERT INTO playlists(id,name,description,cover_path,created_at) VALUES(?,?,?,?,?)')
  for(let id=1;id<=125;id++)insert.run(id,id===1?' Target ':id===2?'İSTANBUL':`List ${id}`,id===3?'Literal %_\\ needle':null,id===4?'':null,id%2?'2026-01':'2026-02')
  db.exec('INSERT INTO playlist_video(playlist_id,video_id,position) SELECT id,1,0 FROM playlists')
  return db
}
it('matches full global list order, counts, cover fallback and per-video membership over all pages',()=>{
  setup()
  const full=listPlaylistsForVideo(1)
  const actual=[]
  for(const offset of [0,60,120]){
    const page=listPlaylistBrowsePage({videoId:1,offset})
    assert.equal(page.total,125);assert.ok(page.items.length<=60);actual.push(...page.items)
  }
  assert.deepEqual(actual,full.map(item=>({id:item.id,name:item.name,description:item.description,preview_cover_path:item.preview_cover_path,video_count:item.video_count,contains_video:item.contains_video})))
  assert.equal(actual.find(item=>item.id===4)!.preview_cover_path,'')
  assert.equal(listPlaylistBrowsePage({offset:9999}).offset,120)
})
it('searches full Unicode text literally and finds exact names outside the current page',()=>{
  const db=setup()
  for(const search of ['needle','%_\\','i̇sta','target']){
    const page=listPlaylistBrowsePage({search})
    const expected=listPlaylists().filter(item=>item.name.toLowerCase().includes(search)||(item.description?.toLowerCase().includes(search)??false))
    assert.deepEqual(page.items.map(item=>item.id),expected.map(item=>item.id))
  }
  db.prepare('UPDATE playlists SET name=?').run('Target extras')
  db.prepare('UPDATE playlists SET name=? WHERE id=1').run(' Target ')
  const page=listPlaylistBrowsePage({search:'target',limit:1})
  assert.notEqual(page.items[0].id,1);assert.equal(page.hasExactName,true)
  db.prepare('UPDATE playlists SET name=? WHERE id=1').run('I')
  assert.equal(listPlaylistBrowsePage({search:'ı',locale:'tr'}).hasExactName,true)
})
it('bounds NUL/UTF8 display fields and preserves stored full identity without projecting oversized covers',()=>{
  const db=setup(),name='\0'+'😀'.repeat(200000)
  db.prepare('UPDATE playlists SET name=?,description=?,cover_path=?').run(name,'\u0001'.repeat(10000),'\\'.repeat(4096))
  const page=listPlaylistBrowsePage({limit:100})
  assert.equal(Array.from(page.items[0].name).length,129)
  assert.equal(Array.from(page.items[0].description!).length,257)
  assert.ok(Buffer.byteLength(JSON.stringify(page))<4*1024*1024)
  assert.equal((db.prepare('SELECT name FROM playlists WHERE id=1').get() as {name:string}).name,name)
  db.prepare('UPDATE playlists SET cover_path=? WHERE id=1').run('x'.repeat(4097))
  assert.equal(listPlaylistBrowsePage({search:'',offset:120}).items.find(item=>item.id===1)?.preview_cover_path,null)
})
it('keeps total, page, membership and exact-name checks on one WAL snapshot',t=>{
  const db=setup(),external=new Database(db.name),prepare=db.prepare.bind(db)
  let committed=false
  t.mock.method(db,'prepare',(sql:string)=>{
    if(!committed && sql.includes('WITH page AS MATERIALIZED')){committed=true;external.exec('DELETE FROM playlists')}
    return prepare(sql)
  })
  try {
    const page=listPlaylistBrowsePage({search:'target',videoId:1})
    assert.equal(committed,true);assert.equal(page.total,1);assert.equal(page.hasExactName,true);assert.equal(page.items[0].contains_video,true)
    assert.equal(listPlaylistBrowsePage({}).total,0)
  }finally{external.close()}
})
it('rejects unsafe API bounds before SQL and shares IPC boundaries',t=>{
  const db=setup(),prepare=t.mock.method(db,'prepare',()=>{throw new Error('unexpected SQL')})
  for(const query of [{limit:101},{limit:0},{offset:-1},{offset:Infinity},{videoId:0},{search:'x'.repeat(501)},{locale:'bad_locale'}]){
    assert.equal(appIpcSchemas[IPC.PLAYLIST_LIST_PAGE].safeParse([query]).success,false)
    assert.throws(()=>listPlaylistBrowsePage(query))
  }
  assert.equal(prepare.mock.callCount(),0)
})
