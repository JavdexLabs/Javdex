import {it} from 'node:test'
import assert from 'node:assert/strict'
import {ScanAuditIndexSession} from './scanAuditIndexSession'
import type {ScanAuditIndexPage} from './scanAuditReadIndex'
const snapshot={libraryId:1,runId:'one',finishedAt:'now'},limits={sourceBytes:1000,indexBytes:10000,pageBytes:1000}
it('reuses one index and releases it before changes, revision failures and disposal',()=>{
 let revision='one',builds=0,live=0,maxLive=0,failBuild=false,failRead=false,failRevision=false
 const session=new ScanAuditIndexSession({revision:()=>{if(failRevision)throw new Error('revision failed');return revision},build:identity=>{
  builds++;if(failBuild)throw new Error('build failed')
  live++;maxLive=Math.max(live,maxLive);let disposed=false
  return {readPage:query=>{if(failRead)throw new Error('read failed');return {snapshot:identity,section:query.section,items:[],total:0,limit:100,offset:query.offset??0} as ScanAuditIndexPage},dispose:()=>{assert.equal(disposed,false);disposed=true;live--}}
 }})
 session.read(snapshot,{section:'files'},limits);session.read(snapshot,{section:'files',offset:100},limits);assert.equal(builds,1)
 session.read({...snapshot,runId:'two'},{section:'files'},limits);assert.equal(builds,2)
 session.read({...snapshot,runId:'two'},{section:'files'},{...limits,pageBytes:2000});assert.equal(builds,3)
 revision='two';session.read(snapshot,{section:'files'},limits);assert.equal(builds,4);assert.equal(maxLive,1)
 failRead=true;assert.throws(()=>session.read(snapshot,{section:'files'},limits),/read failed/);assert.equal(live,0)
 failRead=false;failBuild=true;assert.throws(()=>session.read(snapshot,{section:'files'},limits),/build failed/);assert.equal(live,0)
 failBuild=false;session.read(snapshot,{section:'files'},limits);failRevision=true;assert.throws(()=>session.read(snapshot,{section:'files'},limits),/revision failed/);assert.equal(live,0)
 failRevision=false;session.read(snapshot,{section:'files'},limits);session.dispose();session.dispose();assert.equal(live,0)
 assert.throws(()=>session.read(snapshot,{section:'files'},limits),/disposed/)
})
it('expires an idle index, resets the deadline on use and cancels expiry on disposal',t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let builds=0,closed=0
 const session=new ScanAuditIndexSession({idleMs:30,revision:()=>'',build:()=>{builds++;return{readPage:()=>({snapshot,section:'files',items:[],total:0,limit:100,offset:0}),dispose:()=>{closed++}}}})
 session.read(snapshot,{section:'files'},limits);t.mock.timers.tick(20)
 session.read(snapshot,{section:'files'},limits);t.mock.timers.tick(20);assert.equal(closed,0)
 t.mock.timers.tick(10);assert.equal(closed,1)
 session.read(snapshot,{section:'files'},limits);assert.equal(builds,2)
 session.dispose();t.mock.timers.tick(100);assert.equal(closed,2)
})
it('upgrades raw to combined views with one live index, then reuses it for both operations',t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let builds=0,live=0,fail=false
 const session=new ScanAuditIndexSession({idleMs:30,revision:()=>'',build:(identity,_limits,options)=>{
  assert.equal(live,0);live++;builds++
  return {readPage:()=>({snapshot:identity,section:'files',items:[],total:0,limit:100,offset:0}),
   readViewPage:()=>{assert.equal(options.views,true);if(fail)throw new Error('view failed');return{snapshot:identity,items:[],total:0,auditAvailable:true,attentionBadgeCount:0,limit:100,offset:0,anchorOffset:null}},dispose:()=>{live--}}
 }})
 session.read(snapshot,{section:'files'},limits);assert.equal(builds,1)
 session.readView(snapshot,{tab:'failed'},limits);assert.equal(builds,2)
 session.read(snapshot,{section:'files'},limits);session.readView(snapshot,{tab:'all',search:'test'},limits);assert.equal(builds,2)
 t.mock.timers.tick(30);assert.equal(live,0)
 session.readView(snapshot,{tab:'all'},limits);assert.equal(builds,3)
 fail=true;assert.throws(()=>session.readView(snapshot,{tab:'all'},limits),/view failed/);assert.equal(live,0)
 fail=false;session.readView(snapshot,{tab:'all'},limits);assert.equal(builds,4)
 session.dispose();assert.equal(live,0)
 assert.throws(()=>session.readView(snapshot,{tab:'all'},limits),/disposed/)
})
