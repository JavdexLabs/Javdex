/** Actual remote-page audit component with synthetic paged API and visible-page presence. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {chromium} from 'playwright-core'
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-presence-'))
const output=path.resolve(process.env.JAVDEX_AUDIT_UI_OUTPUT??path.join(root,'results'))
fs.mkdirSync(output,{recursive:true})
fs.writeFileSync(path.join(root,'index.html'),'<html><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root,'fixture.jsx'),`
import React from 'react';import{createRoot}from'react-dom/client';
import ${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/styles/global.css'))};
window.React=React;window.__requests=[];window.__fail=false;window.__opened=[];window.__hold=false;window.__releases=[];window.__pages=[];window.__anchorHold=false;window.__anchorRelease=null;
window.api={scan:{pendingAuditPresence:async(libraryId,input)=>{const ids=[...input.groupIds,...input.identityIds,...input.scrapeIds];window.__requests.push(ids);if(window.__fail){window.__fail=false;throw new Error('fixture')};if(window.__hold)await new Promise(resolve=>window.__releases.push(resolve));return {groupIds:input.groupIds.filter(id=>id===1||id===101||id===201),identityIds:[],scrapeIds:input.scrapeIds.filter(id=>id===1||id===101||id===201)};},revealAuditFile:async()=>({ok:true})}};
const summary={libraryId:1,runId:'run',configRevision:1,trigger:'manual',startedAt:'2026-09-10T00:00:00Z',finishedAt:'2026-09-10T00:01:00Z',status:'success',scannedFiles:201,resourcesAdded:201,resourcesUpdated:0,resourcesRemoved:0,primaryResourcesPromoted:0,videosDeleted:0,skippedFiles:0,failedFiles:0,pendingScanGroups:0,pendingScanResources:201,offlineFolders:[],errorSummary:null};
const audit={...summary,schemaVersion:2,files:Array.from({length:201},(_,i)=>({outcome:'added',rootId:1,sourceKind:'local',filePath:'/synthetic/FILE-'+(i+1)+'.mp4',videoId:i+1,videoCode:'FILE-'+(i+1),resourceId:i+1,resourceKind:'local',createdVideo:true,nfo:{disposition:'pending-candidate',pendingScrapeId:i+1}})),removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]};
if(location.search.includes('groups')){audit.files=audit.files.map(entry=>({...entry,nfo:undefined,outcome:'pending',groupId:entry.resourceId,normalizedCode:entry.videoCode,addedToQueue:true}));audit.pendingGroups=audit.files.map(entry=>({groupId:entry.groupId,normalizedCode:entry.normalizedCode,resourceCount:1}));}
const {buildScanAuditViewItems}=await import(${JSON.stringify('/@fs'+path.join(repo,'src/shared/scanAuditView.ts'))});
window.api.scan.getLatest=()=>{throw new Error('Full snapshot forbidden')};
window.api.scan.getAuditViewPage=async(snapshot,query)=>{
window.__pages.push(structuredClone({snapshot,query}));
if(query.anchor&&window.__anchorHold)await new Promise(resolve=>window.__anchorRelease=resolve);
let items=buildScanAuditViewItems({audit,unrecognized:[],activeTab:query.tab,outcome:query.outcome??'all',changesFilter:query.changesFilter??'all'});
const needle=query.tab==='all'?(query.search??'').trim().toLocaleLowerCase(query.locale):'';
if(needle)items=items.filter(item=>(item.title+' '+item.detail+' '+(item.path??'')).toLocaleLowerCase(query.locale).includes(needle));
const total=items.length,limit=query.limit??100;let offset=Math.min(query.offset??0,Math.max(0,Math.floor((total-1)/limit)*limit)),anchorOffset=null;
if(query.anchor){const position=items.findIndex(item=>item.groupId?query.anchor.kind==='group'&&item.groupId===query.anchor.id:query.anchor.kind==='path'&&item.path===query.anchor.value);if(position>=0){anchorOffset=Math.floor(position/limit)*limit;offset=anchorOffset;}}
return {snapshot,auditAvailable:true,items:items.slice(offset,offset+limit),total,attentionBadgeCount:201,limit,offset,anchorOffset};};
const Panel=(await import(${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/components/settings/LibraryScanAuditPanel.tsx'))})).default;
function Host(){const[selected,setSelected]=React.useState(null);return <div style={{padding:16}}><Panel summary={summary} revision={1} onRefreshHistory={async()=>{}} selected={selected} onSelect={setSelected} onOpenVideo={()=>{}} onOpenPending={target=>window.__opened.push(target)}/></div>}
createRoot(document.getElementById('root')).render(<Host/>);
`)
let server,browser
const results=[]
try{
 server=await createServer({configFile:false,root,cacheDir:path.join(root,'.vite'),plugins:[react()],resolve:{alias:{'@shared':path.join(repo,'src/shared'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,repo]}}})
 await server.listen();browser=await chromium.launch({channel:process.env.JAVDEX_BROWSER_CHANNEL||'chrome',headless:true})
 for(const viewport of [{width:1000,height:640},{width:1440,height:900}]){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port)
  await page.getByRole('button',{name:'处理待办',exact:true}).waitFor()
  assert.equal(await page.locator('[data-audit-anchor]').count(),100)
  await page.evaluate(()=>window.__fail=true)
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByText('待办状态读取失败',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'处理待办',exact:true}).count(),0)
  await page.getByRole('button',{name:'重试状态',exact:true}).click()
  await page.getByRole('button',{name:'处理待办',exact:true}).waitFor()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.waitForFunction(()=>window.__requests.at(-1)?.[0]===201)
  await page.getByRole('button',{name:'处理待办',exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>window.__opened),[{domain:'scrape',id:'201'}])
  await page.getByRole('button',{name:/全部文件/}).click()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'处理',exact:true}).click()
  await page.getByRole('button',{name:'处理待办',exact:true}).waitFor()
  const rows=await page.locator('[data-audit-anchor]').count();assert.equal(rows,1)
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-audit-anchor')?.includes('FILE-201'))
  const focused=await page.evaluate(()=>document.activeElement.getAttribute('data-audit-anchor'));assert.ok(focused.includes('FILE-201'))
  const focusedBox=await page.locator('[data-audit-anchor]').boundingBox();assert.ok(focusedBox && focusedBox.y>=0 && focusedBox.y+focusedBox.height<=viewport.height+1)
  const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}))
  assert.ok(geometry.scrollWidth<=geometry.width+1);assert.deepEqual(errors,[])
  assert.ok((await page.evaluate(()=>window.__requests)).every(ids=>ids.length<=100))
  assert.ok((await page.evaluate(()=>window.__pages)).every(({query})=>query.limit<=100));
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}.png`)})
  results.push({viewport,mode:'scrape',rows,focused,geometry,requests:await page.evaluate(()=>window.__requests),pages:await page.evaluate(()=>window.__pages),errors});
  await page.getByRole('button',{name:/全部文件/}).click()
  await page.getByPlaceholder('搜索番号、文件名或路径…').fill('FILE-201')
  await page.waitForFunction(()=>window.__pages.at(-1)?.query.search==='FILE-201' && document.querySelectorAll('[data-audit-anchor]').length===1)
  assert.equal(await page.locator('[data-audit-anchor]').count(),1)
  assert.ok((await page.locator('[data-audit-anchor]').getAttribute('data-audit-anchor')).includes('FILE-201'))
  assert.deepEqual(errors,[])
  results.push({viewport,mode:'search',pages:await page.evaluate(()=>window.__pages),errors})

  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/?groups')
  await page.getByRole('button',{name:'处理待办',exact:true}).waitFor()
  await page.getByRole('button',{name:/全部文件/}).click()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'处理',exact:true}).waitFor()
  await page.evaluate(()=>window.__hold=true)
  await page.getByRole('button',{name:'处理',exact:true}).click()
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-audit-anchor')==='group:201' && window.__releases.length>0)
  assert.equal(await page.getByRole('button',{name:'处理待办',exact:true}).count(),0)
  assert.equal(await page.getByText('读取中…',{exact:true}).count(),1)
  const heldFocus=await page.evaluate(()=>document.activeElement.getAttribute('data-audit-anchor'))
  await page.evaluate(()=>{window.__hold=false;window.__releases.splice(0).forEach(resolve=>resolve())})
  await page.getByRole('button',{name:'处理待办',exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>window.__opened),[{domain:'scan',id:'201'}])
  const finalAnchor=await page.locator('[data-audit-anchor]').getAttribute('data-audit-anchor');assert.equal(finalAnchor,'group:201')
  await page.screenshot({path:path.join(output,`groups-${viewport.width}x${viewport.height}.png`)})
  assert.deepEqual(errors,[])
  results.push({viewport,mode:'group-delayed',heldFocus,finalAnchor,requests:await page.evaluate(()=>window.__requests),pages:await page.evaluate(()=>window.__pages),errors});
  await page.getByRole('button',{name:/全部文件/}).click()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'处理',exact:true}).waitFor()
  await page.evaluate(()=>window.__anchorHold=true)
  await page.getByRole('button',{name:'处理',exact:true}).click()
  await page.waitForFunction(()=>window.__anchorRelease!==null)
  await page.getByRole('button',{name:/异常与待办/}).focus()
  await page.evaluate(()=>{window.__anchorHold=false;window.__anchorRelease()})
  await page.getByRole('button',{name:'处理待办',exact:true}).waitFor()
  await page.waitForTimeout(50)
  const userFocus=await page.evaluate(()=>document.activeElement?.textContent)
  assert.match(userFocus,/异常与待办/)
  assert.deepEqual(errors,[])
  results.push({viewport,mode:'anchor-user-focus',userFocus,pages:await page.evaluate(()=>window.__pages),errors});await page.close()

 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results.map(({viewport,mode,errors})=>({viewport,mode,errors}))))
}finally{await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true})}
