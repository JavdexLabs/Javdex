/** Actual pending page/router/styles against a synthetic IPC fixture. No Electron/user catalog. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
const repo=process.cwd(), root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-actress-ui-'))
const output=path.resolve(process.env.JAVDEX_ACTRESS_UI_OUTPUT ?? path.join(root,'results'))
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
window.api={mediaLibraries:{list:async()=>[]},scan:{countPendingQueue:async()=>0,pagePendingQueue:async()=>({items:[],total:0,offset:0})},scrape:{countPending:async()=>0,pagePending:async()=>({items:[],total:0,offset:0})},actresses:{list:async()=>[],get:async()=>null},actressScrape:{
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
  await page.locator('input[name="pending-actress-owner"]').check()
  assert.deepEqual(await page.evaluate(()=>window.__details),['actor-001'])
  await page.getByRole('button',{name:'查看「Candidate-1」的详情',exact:true}).click()
  await page.waitForFunction(()=>window.__location.pathname.includes('/actress/'))
  assert.deepEqual(await page.evaluate(()=>window.__details),['actor-001'])
  await page.evaluate(()=>window.__navigate(-1))
  await page.waitForFunction(()=>window.__location.pathname==='/pending')
  await page.locator('input[name="pending-actress-owner"]:checked').waitFor()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'Actor-51 刮削 1 · 历史 0',exact:true}).waitFor()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'Actor-101 刮削 1 · 历史 0',exact:true}).waitFor()
  assert.equal(await page.locator('button[aria-current]').count(),1)
  await page.locator('input[name="pending-actress-owner"]').check()
  await page.getByRole('button',{name:'确认名称归属',exact:true}).click()
  await page.waitForFunction(()=>window.__location.search.includes('actor-051'))
  console.log('focus after delete',await page.evaluate(()=>({tag:document.activeElement?.tagName,role:document.activeElement?.getAttribute('role'),text:document.activeElement?.textContent?.slice(0,180),location:window.__location})))
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-current')==='true')
  const focusAfterDelete=await page.evaluate(()=>document.activeElement.textContent)
  assert.ok(focusAfterDelete.includes('Actor-51'))
  assert.equal(await page.locator('button[aria-current]').count(),50)
  await page.getByRole('button',{name:'上一页',exact:true}).click()
  await page.getByRole('button',{name:'Actor-1 刮削 1 · 历史 0',exact:true}).waitFor()
  await page.evaluate(()=>{window.__fail=true})
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByText('演员冲突队列读取失败',{exact:true}).waitFor()
  await page.getByRole('button',{name:'重试',exact:true}).click()
  await page.getByRole('button',{name:'Actor-52 刮削 1 · 历史 0',exact:true}).waitFor()
  await page.evaluate(()=>{window.__failDetail=true})
  await page.getByRole('button',{name:'Actor-52 刮削 1 · 历史 0',exact:true}).click()
  await page.getByText('演员冲突详情读取失败',{exact:true}).waitFor()
  await page.getByRole('button',{name:'重试',exact:true}).click()
  await page.locator('input[name="pending-actress-owner"]').waitFor()
  await page.evaluate(()=>{window.__stale=true})
  await page.locator('input[name="pending-actress-owner"]').check()
  await page.getByRole('button',{name:'确认名称归属',exact:true}).click()
  await page.waitForFunction(()=>typeof window.__finishStale==='function')
  const previousPage=page.getByRole('button',{name:'上一页',exact:true})
  await previousPage.focus()
  await page.evaluate(()=>window.__finishStale())
  await page.waitForFunction(()=>document.body.textContent.includes('数据已变化，已刷新，请重新确认'))
  await page.waitForFunction(()=>!document.querySelector('input[name="pending-actress-owner"]:checked'))
  assert.equal(await previousPage.evaluate(element=>element===document.activeElement),true)
  await page.getByRole('button',{name:'上一页',exact:true}).scrollIntoViewIfNeeded()
  const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight}))
  assert.ok(geometry.scrollWidth<=geometry.width+1)
  const pager=await page.getByLabel('演员冲突队列分页',{exact:true}).boundingBox()
  assert.ok(pager && pager.y>=0 && pager.y+pager.height<=viewport.height+1)
  const heading=await page.getByRole('heading',{name:'待确认',exact:true}).boundingBox()
  assert.ok(heading && heading.y>=0 && heading.y+heading.height<=viewport.height)
  assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}.png`)})
  results.push({viewport,geometry,pager,focusAfterDelete,pages:await page.evaluate(()=>window.__pages),details:await page.evaluate(()=>window.__details),errors})
  await page.close()
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n')
 console.log(JSON.stringify(results))
} finally {await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true})}
