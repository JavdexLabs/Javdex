/** Actual classification list pages/styles with synthetic IPC and bounded query-cache evidence. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {chromium} from 'playwright-core'
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-classification-ui-'))
const output=path.resolve(process.env.JAVDEX_CLASSIFICATION_UI_OUTPUT??path.join(root,'results'));fs.mkdirSync(output,{recursive:true})
const local=p=>JSON.stringify('/@fs'+path.join(repo,p))
fs.writeFileSync(path.join(root,'index.html'),'<html><body><div id="root" style="height:100vh"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root,'image.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#334455"/><circle cx="320" cy="175" r="95" fill="#879aab"/></svg>')
fs.writeFileSync(path.join(root,'fixture.jsx'),`
import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter,Route,Routes,useNavigate,useLocation,useParams}from'react-router-dom';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import ${local('src/renderer/src/styles/global.css')};
window.React=React;window.__calls=[];window.__total=125;
const read=async(kind,query)=>{window.__calls.push({kind,query});if(window.__fail){window.__fail=false;throw Error('Synthetic page failed')}const total=query.search?17:window.__total,offset=query.offset??0;return{items:Array.from({length:Math.min(60,Math.max(0,total-offset))},(_,n)=>({id:offset+n+1,mainName:kind+' '+(offset+n+1),imagePath:kind==='director'?'directors/'+(offset+n+1)+'.jpg':null,fallbackCoverPath:null,videoCount:123,updatedAt:'2026-01-01',ownerOrganization:{id:1,mainName:'示例制作商'}})),total,offset,limit:60}};
window.api={directors:{page:q=>read('director',q),list:()=>{throw Error('Full list forbidden')}},series:{page:q=>read('series',q),list:()=>{throw Error('Full list forbidden')}},organizations:{page:q=>read(q.role,q),list:()=>{throw Error('Full list forbidden')}}};
const Director=(await import(${local('src/renderer/src/pages/DirectorListPage.tsx')})).default;
const Series=(await import(${local('src/renderer/src/pages/SeriesListPage.tsx')})).default;const Organization=(await import(${local('src/renderer/src/pages/OrganizationListPage.tsx')})).default;
const Shell=(await import(${local('src/renderer/src/components/ListDetailShell.tsx')})).default;
function Surface(){const {type}=useParams();return <Shell list={type==='series'?<Series/>:type==='director'?<Director/>:<Organization role={type}/>} detailMatchPath={['/facet/director/d/:id','/facet/series/s/:id','/facet/:type/o/:id']} detailMatchEnd={false}/>}
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});window.__client=client;
function Nav(){window.__navigate=useNavigate();window.__location=useLocation();return null}
const kind=new URLSearchParams(location.search).get('kind')||'series';
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/facet/'+kind]}><Nav/><Routes><Route path="/facet/:type" element={<Surface/>}><Route path="d/:id/*" element={<div>Detail fixture</div>}/><Route path="s/:id/*" element={<div>Detail fixture</div>}/><Route path="o/:id/*" element={<div>Detail fixture</div>}/></Route></Routes></MemoryRouter></QueryClientProvider>);
`)
let server,browser;const results=[]
try {
 server=await createServer({configFile:false,root,cacheDir:path.join(root,'.vite'),plugins:[react(),{name:'synthetic-media-protocol',transform(code,id){if(id===path.join(repo,'src/renderer/src/api.ts'))return code.replace('const url = `media://${normalized}`',"const url = '/image.svg?path=' + encodeURIComponent(normalized)")}}],resolve:{alias:{'@shared':path.join(repo,'src/shared'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom'),'react-router-dom':path.join(repo,'node_modules/react-router-dom'),'@tanstack/react-query':path.join(repo,'node_modules/@tanstack/react-query')}},server:{host:'127.0.0.1',port:0,fs:{allow:[repo,root]}}})
 await server.listen();browser=await chromium.launch({channel:process.env.JAVDEX_BROWSER_CHANNEL||'chrome',headless:true})
 for(const viewport of [{width:1000,height:640},{width:1440,height:900}]) for(const kind of ['series','maker','director']) {
  const page=await browser.newPage({viewport}),errors=[],mediaRequests=[];page.on('request',request=>{if(request.url().includes('/image.svg?'))mediaRequests.push(request.url())});page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/?kind='+kind)
  await page.waitForFunction(()=>document.querySelectorAll('.facet-card').length===60)
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.facet-name')?.textContent.endsWith(' 61'))
  await page.evaluate(()=>window.__fail=true)
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'重试',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.facet-card').length===5)
  assert.equal(await page.evaluate(()=>new URLSearchParams(window.__location.search).get('facetOffset')),'120')
  await page.locator('.facet-card').first().click()
  await page.waitForFunction(kind=>window.__location.pathname.includes(kind==='series'?'/s/':kind==='director'?'/d/':'/o/'),kind)
  await page.evaluate(kind=>window.__navigate('/facet/'+kind+'?facetOffset=120'),kind)
  await page.waitForFunction(()=>document.querySelectorAll('.facet-card').length===5)
  const next=page.getByRole('button',{name:'下一页',exact:true});await next.scrollIntoViewIfNeeded()
  const geometry=await next.evaluate(el=>({bottom:el.getBoundingClientRect().bottom,viewport:innerHeight,horizontal:document.documentElement.scrollWidth>innerWidth}))
  assert.ok(geometry.bottom<=geometry.viewport);assert.equal(geometry.horizontal,false)
  if(kind==='director') await page.waitForFunction(()=>Array.from(document.querySelectorAll('.facet-card img')).every(img=>img.complete&&img.naturalWidth>0))
  await page.screenshot({path:path.join(output,kind+'-'+viewport.width+'x'+viewport.height+'.png')})
  await page.getByRole('searchbox').fill('stale-draft')
  await page.evaluate(kind=>window.__navigate('/facet/'+kind+'?facetOffset=60'),kind)
  await page.waitForFunction(()=>document.querySelector('.facet-name')?.textContent.endsWith(' 61'))
  await page.evaluate(kind=>window.__navigate('/facet/'+kind+'?facetOffset=120'),kind)
  await page.waitForTimeout(350)
  assert.equal(await page.getByRole('searchbox').inputValue(),'')
  assert.equal(await page.evaluate(()=>new URLSearchParams(window.__location.search).get('q')),null)
  await page.getByRole('searchbox').fill('stale-detail')
  await page.locator('.facet-card').first().click()
  await page.waitForFunction(kind=>window.__location.pathname.includes(kind==='series'?'/s/':kind==='director'?'/d/':'/o/'),kind)
  await page.waitForTimeout(350)
  assert.equal(await page.evaluate(()=>new URLSearchParams(window.__location.search).get('q')),null)
  await page.evaluate(kind=>window.__navigate('/facet/'+kind+'?facetOffset=120'),kind)
  await page.waitForFunction(()=>document.querySelectorAll('.facet-card').length===5)
  // Navigate many pages without keeping successful inactive pages in the cache.
  await page.evaluate(()=>window.__total=6000)
  for(let n=0;n<100;n++) {
    await page.evaluate(({kind,n})=>window.__navigate('/facet/'+kind+(n?'?facetOffset='+n*60:'')),{kind,n})
    await page.waitForFunction(n=>document.querySelector('.facet-name')?.textContent.endsWith(' '+(n*60+1)),n)
  }
  await page.waitForFunction(()=>window.__client.getQueryCache().getAll().length<=1)
  const cacheCount=await page.evaluate(()=>window.__client.getQueryCache().getAll().length)
  assert.equal(await page.locator('.facet-card').count(),60)
  await page.getByRole('searchbox').fill('needle')
  await page.waitForFunction(()=>document.querySelectorAll('.facet-card').length===17)
  assert.equal(await page.evaluate(()=>new URLSearchParams(window.__location.search).get('facetOffset')),null)
  if(kind==='director'){assert.ok(mediaRequests.length>0);assert.ok(mediaRequests.every(value=>new URL(value).searchParams.get('size')==='640'))}
  assert.deepEqual(errors,[])
  results.push({kind,viewport,geometry,cacheCount,pagesTraversed:100,draftNavigationPassed:true,maxFinalCards:60,errors,mediaRequests,calls:await page.evaluate(()=>window.__calls)})
  await page.close()
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(output)
} finally {await browser?.close();await server?.close();if(!output.startsWith(root+path.sep))fs.rmSync(root,{recursive:true,force:true})}
