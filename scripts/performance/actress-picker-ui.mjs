/** Actual pending page/router/styles against a synthetic IPC fixture. No Electron/user catalog. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
const repo=process.cwd(), root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-picker-ui-'))
const output=path.resolve(process.env.JAVDEX_PICKER_UI_OUTPUT ?? path.join(root,'results'))
fs.mkdirSync(output,{recursive:true})
fs.writeFileSync(path.join(root,'index.html'),'<html><head><style>html,body,#root{height:100%;margin:0}#root{display:flex;min-height:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root,'fixture.jsx'),`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,useNavigate,useLocation} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import ${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/styles/global.css'))};
window.React=React;window.__pages=[];window.__details=[];window.__fail=false;window.__failDetail=false;window.__ids=Array.from({length:101},(_,i)=>i+1);
const key=id=>'actor-'+String(id).padStart(3,'0');
const group=id=>({status:'conflict',normalizedName:key(id),displayName:'Actor-'+id,currentOwner:null,claimants:[],pendingNameClaims:[],mergePairs:[],
 candidates:[{pendingId:id,revision:1,actressId:id+1000,actressRevision:1,actressMainName:'Candidate-'+id,actressAvatarPath:null,plugin:{name:'Fixture',source:'builtin'},queryName:'Fixture',selectedFields:['aliases'],applicableFields:['aliases'],mode:'fillEmpty',result:{aliases:[key(id)]},warnings:[],createdAt:'2026',resources:[],conflicts:[{name:key(id),normalizedName:key(id),type:'alias'}],fieldImpacts:[],fieldImpactsWhenAssignedToCandidate:[],willApplyAfterDecision:true,remainingConflictCountAfterDecision:0}]});
window.api={mediaLibraries:{list:async()=>[]},scan:{countPendingQueue:async()=>0,pagePendingQueue:async()=>({items:[],total:0,offset:0})},scrape:{countPending:async()=>0,pagePending:async()=>({items:[],total:0,offset:0})},actresses:{list:()=>{throw new Error('Full actress candidates forbidden')},
 pickerPage:async query=>{(window.__pickerQueries??=[]).push(query);if(window.__failPicker){window.__failPicker=false;throw new Error('picker error')}
 const all=Array.from({length:101},(_,i)=>({id:2001+i,main_name:'Choice-'+(2001+i),avatar_path:null})).filter(item=>!query.search||item.main_name.includes(query.search));
 return {items:all.slice(query.offset,query.offset+40),hasMore:all.length>query.offset+40,offset:query.offset}},
 get:()=>{throw new Error('Full actress detail forbidden for choices')},
 pickerGet:async id=>{(window.__choiceGets??=[]).push(id);if(window.__holdChoice){window.__holdChoice=false;return new Promise(resolve=>{window.__resolveChoice=resolve})}return {main_name:'Current-'+id,revision:7}}
},actressScrape:{
 listConflicts:()=>{throw new Error('Unbounded actor queue')},conflictSummary:async()=>({groupCount:window.__ids.length}),
 pageConflicts:async query=>{window.__pages.push(query);if(window.__fail){window.__fail=false;throw new Error('fixture page failure')}
 const rank=query.anchorName?window.__ids.indexOf(Number(query.anchorName.slice(6))):-1;
 const offset=rank>=0?Math.floor(rank/50)*50:Math.min(query.offset||0,Math.max(0,Math.floor((window.__ids.length-1)/50)*50));
 return {total:window.__ids.length,offset,items:window.__ids.slice(offset,offset+50).map(id=>({normalizedName:key(id),displayName:'Actor-'+id,status:'conflict',candidateCount:1,pendingNameClaimCount:0,avatarPath:null}))}},
 getConflict:async name=>{window.__details.push(name);if(window.__failDetail){window.__failDetail=false;throw new Error('fixture detail failure')}const id=Number(name.slice(6));return window.__ids.includes(id)?group(id):null},
 resolveConflict:async input=>{if(window.__stale){await new Promise(resolve=>{window.__finishStale=resolve});return {status:'stale',message:'Fixture stale'}}window.__ids=window.__ids.filter(id=>key(id)!==input.snapshot.normalizedName);return {status:'success',remainingPending:window.__ids.length}},
 inspectConflictName:async()=>({normalizedName:'x',status:'available'}),validateIllegalNameReplacements:async()=>({status:'valid'})
}};
function Probe(){window.__navigate=useNavigate();window.__location=useLocation();return null}
const Page=(await import(${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/pages/PendingCenterPage.tsx'))})).default;
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={['/pending?type=actress']}><Probe/><Page/></MemoryRouter></QueryClientProvider>);
`)
let server,browser
const results=[]
try {
 server=await createServer({configFile:false,root,cacheDir:path.join(root,'.vite'),plugins:[react()],resolve:{alias:{
  '@shared':path.join(repo,'src/shared'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom'),
  'react-router-dom':path.join(repo,'node_modules/react-router-dom'),'@tanstack/react-query':path.join(repo,'node_modules/@tanstack/react-query')
 }},server:{host:'127.0.0.1',port:0,fs:{allow:[root,repo]}}})
 await server.listen();const port=server.httpServer.address().port
 browser=await chromium.launch({channel:process.env.JAVDEX_BROWSER_CHANNEL||'chrome',headless:true})
 for(const viewport of [{width:1000,height:640},{width:1440,height:900}]) {
  const page=await browser.newPage({viewport});const errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}`)
  await page.getByRole('button',{name:'Actor-1 刮削 1 · 历史 0',exact:true}).waitFor()
  await page.getByRole('button',{name:/选择其他演员…/}).click()
  const modal=page.getByRole('dialog',{name:'选择其他演员',exact:true})
  const choices=modal.getByRole('group',{name:'其他演员',exact:true})
  await choices.getByRole('button',{name:'Choice-2001 选择为拟定归属',exact:true}).waitFor()
  assert.equal(await choices.getByRole('button').count(),40)
  await modal.getByRole('button',{name:'下一页',exact:true}).click()
  await choices.getByRole('button',{name:'Choice-2041 选择为拟定归属',exact:true}).click()
  await modal.waitFor({state:'hidden'})
  assert.ok((await page.locator('.conflict-workbench-owner--other').textContent()).includes('Current-2041'))
  await page.getByRole('button',{name:'重新选择演员',exact:true}).click()
  await choices.getByRole('button',{name:'Choice-2001 选择为拟定归属',exact:true}).waitFor()
  await modal.getByRole('button',{name:'下一页',exact:true}).click()
  const selected=choices.getByRole('button',{name:'Choice-2041 选择为拟定归属',exact:true})
  await selected.waitFor();assert.equal(await selected.getAttribute('aria-pressed'),'true')
  await page.evaluate(()=>{window.__failPicker=true})
  await modal.getByRole('button',{name:'下一页',exact:true}).click()
  await modal.getByText('演员候选读取失败',{exact:true}).waitFor()
  await modal.getByRole('button',{name:'重试',exact:true}).click()
  await choices.getByRole('button',{name:'Choice-2081 选择为拟定归属',exact:true}).waitFor()
  assert.equal(await choices.getByRole('button').count(),21)
  await modal.getByRole('searchbox',{name:'搜索其他演员'}).fill('2099')
  await choices.getByRole('button',{name:'Choice-2099 选择为拟定归属',exact:true}).waitFor()
  assert.equal(await choices.getByRole('button').count(),1)
  await page.evaluate(()=>{window.__holdChoice=true})
  await choices.getByRole('button').click()
  await page.waitForFunction(()=>typeof window.__resolveChoice==='function')
  await modal.getByRole('button',{name:'取消',exact:true}).click()
  await page.getByRole('button',{name:'重新选择演员',exact:true}).click()
  await choices.getByRole('button',{name:'Choice-2002 选择为拟定归属',exact:true}).click()
  await modal.waitFor({state:'hidden'})
  await page.evaluate(async()=>{window.__resolveChoice({main_name:'Old late choice',revision:9});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})
  assert.ok((await page.locator('.conflict-workbench-owner--other').textContent()).includes('Current-2002'))
  await page.getByRole('button',{name:'重新选择演员',exact:true}).click()
  await choices.getByRole('button',{name:'Choice-2001 选择为拟定归属',exact:true}).waitFor()
  const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight}))
  assert.ok(geometry.scrollWidth<=geometry.width+1)
  const pager=await modal.getByLabel('演员候选分页',{exact:true}).boundingBox()
  assert.ok(pager && pager.y>=0 && pager.y+pager.height<=viewport.height+1)
  const heading=await page.getByRole('heading',{name:'待确认',exact:true}).boundingBox()
  assert.ok(heading && heading.y>=0 && heading.y+heading.height<=viewport.height)
  assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}.png`)})
  results.push({viewport,geometry,pager,queries:await page.evaluate(()=>window.__pickerQueries),choiceGets:await page.evaluate(()=>window.__choiceGets),errors})
  await page.close()
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n')
 console.log(JSON.stringify(results))
} finally {await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true})}
