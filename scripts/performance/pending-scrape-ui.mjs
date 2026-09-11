/** Actual pending page/router/styles against a synthetic IPC fixture. No Electron/user catalog. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
const repo=process.cwd(), root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-pending-ui-'))
const output=path.resolve(process.env.JAVDEX_PENDING_UI_OUTPUT ?? path.join(root,'results'))
fs.mkdirSync(output,{recursive:true})
fs.writeFileSync(path.join(root,'index.html'),'<html><head><style>html,body,#root{height:100%;margin:0}#root{display:flex;min-height:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root,'fixture.jsx'),`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import ${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/styles/global.css'))};
window.React=React;window.__pages=[];window.__details=[];window.__fail=false;
window.api={mediaLibraries:{list:async()=>[]},actressScrape:{listConflicts:()=>{throw new Error('Full actress queue is forbidden')},pageConflicts:async()=>({items:[],total:0,offset:0}),conflictSummary:async()=>({groupCount:0})},scan:{countPendingQueue:async()=>0,pagePendingQueue:async()=>({items:[],total:0,offset:0})},scrape:{
 listPending:()=>{throw new Error('Unbounded inbox');},countPending:async()=>120,
 pagePending:async query=>{window.__pages.push(query);if(window.__fail){window.__fail=false;throw new Error('fixture failure')};
 const anchor=query.videoId||query.anchorId;const offset=anchor?Math.floor((anchor-1)/50)*50:(query.offset||0);
 return {total:120,offset,items:Array.from({length:Math.min(50,120-offset)},(_,i)=>({id:offset+i+1,videoId:offset+i+1,revision:1,code:i===1?'长'.repeat(128)+'…':'CODE-'+(offset+i+1),candidateCount:2,sourceCount:1,stagedCoverPath:null}))};},
 getPending:async id=>{window.__details.push(id);return null;}
}};
const Page=(await import(${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/pages/PendingCenterPage.tsx'))})).default;
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={['/pending?type=scrape']}><Page/></MemoryRouter></QueryClientProvider>);
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
  await page.getByRole('button',{name:'CODE-1 2 个候选 · 1 个来源',exact:true}).waitFor()
  assert.equal(await page.locator('button[aria-current]').count(),50)
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'CODE-51 2 个候选 · 1 个来源',exact:true}).waitFor()
  await page.waitForFunction(()=>window.__details.at(-1)===51)
  await page.evaluate(()=>{window.__fail=true})
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByText('待确认刮削读取失败',{exact:true}).waitFor()
  await page.getByRole('button',{name:'重试',exact:true}).click()
  await page.getByRole('button',{name:'CODE-101 2 个候选 · 1 个来源',exact:true}).waitFor()
  assert.equal(await page.locator('button[aria-current]').count(),20)
  await page.getByRole('button',{name:'上一页',exact:true}).scrollIntoViewIfNeeded()
  const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight}))
  assert.ok(geometry.scrollWidth<=geometry.width+1)
  const pager=await page.getByLabel('刮削队列分页',{exact:true}).boundingBox()
  assert.ok(pager && pager.y>=0 && pager.y+pager.height<=viewport.height+1)
  const heading=await page.getByRole('heading',{name:'待确认',exact:true}).boundingBox()
  assert.ok(heading && heading.y>=0 && heading.y+heading.height<=viewport.height)
  assert.deepEqual(await page.evaluate(()=>window.__details),[1,51,101])
  assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}.png`)})
  results.push({viewport,geometry,pager,pages:await page.evaluate(()=>window.__pages),details:await page.evaluate(()=>window.__details),errors})
  await page.close()
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n')
 console.log(JSON.stringify(results))
} finally {await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true})}
