/** Synthetic IPC + actual window hook/virtual grids. UI/cache evidence, not a timing benchmark. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
const repo = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-catalog-window-ui-'))
const output = path.resolve(process.env.JAVDEX_CATALOG_WINDOW_UI_OUTPUT ?? path.join(root, 'results'))
fs.mkdirSync(output, { recursive: true })
const local = file => JSON.stringify('/@fs' + path.join(repo, file))
fs.writeFileSync(path.join(root, 'index.html'), '<html><body><div id="root" style="height:100vh"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#344658"/><circle cx="320" cy="260" r="160" fill="#9aaebe"/></svg>')
fs.writeFileSync(path.join(root, 'fixture.jsx'), `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import ${local('src/renderer/src/styles/global.css')};
window.React=React;window.__calls=[];window.__selections=[];window.api={};
const {useWindowedCatalog}=await import(${local('src/renderer/src/query/useWindowedCatalog.ts')});
const Poster=(await import(${local('src/renderer/src/components/VirtualPosterGrid.tsx')})).default;
const Actress=(await import(${local('src/renderer/src/components/VirtualActressGrid.tsx')})).default;
const kind=new URLSearchParams(location.search).get('kind')||'video',pageSize=kind==='video'?200:240,total=pageSize*125;
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});window.__client=client;window.__pageSize=pageSize;
const read=async(query)=>{window.__calls.push({...query});if(window.__failOffset===query.offset){window.__failOffset=null;throw Error('Synthetic page failed')}return{items:Array.from({length:Math.min(pageSize,total-query.offset)},(_,i)=>{const id=query.offset+i+1;return kind==='video'?{id,code:'VIDEO-'+id,title:'Synthetic '+query.filter,cover_path:'covers/'+id+'.png',scraped_status:0,rating:0,resource_kinds:[],duration_seconds:120,preferredLibraryId:1,membershipAddedAt:'2026-01-01',libraries:[{libraryId:1,name:'Synthetic library',icon:'folder',color:'blue'}]}:{id,main_name:'ACTRESS-'+id+(query.filter==='initial'?'':' '+query.filter),avatar_path:'avatars/'+id+'.png',gender:'female',scraped_status:0,video_count:3}}),total,readRevision:'synthetic-v1'}};
window.api.videos={list:(_scope,query)=>read(query)};window.api.actresses={listPage:query=>read(query)};
function App(){const [filter,setFilter]=useState('initial'),[selected,setSelected]=useState(new Set());
 const result=useWindowedCatalog([kind,'window-ui',filter],pageSize,offset=>kind==='video'?window.api.videos.list({kind:'all'},{filter,offset}):window.api.actresses.listPage({filter,offset}));window.__result=result;window.__filter=filter;
 const toggle=(item,index)=>{window.__selections.push({id:item.id,index});setSelected(previous=>{const next=new Set(previous);next.has(item.id)?next.delete(item.id):next.add(item.id);return next})};
 return <div className="list-page" style={{height:'100vh'}}><div className="topbar"><label>Fixture filter <input aria-label="Fixture filter" value={filter} onChange={event=>setFilter(event.target.value)}/></label><span> Global rows {result.total}</span></div><div id="grid-host" style={{flex:1,minHeight:0,display:'flex'}}>
 {kind==='video'?<Poster videos={result.items} showLibraryBadges catalogWindow={result.window} selectedIds={selected} selectionMode onToggleSelect={toggle} scrollMemoryKey={'fixture-video:'+filter}/>:<Actress actresses={result.items} catalogWindow={result.window} selectedIds={selected} selectionMode hasMore={false} loadingMore={false} loadMoreFailed={false} onLoadMore={()=>{}} onRetryLoadMore={result.retry} onToggleSelect={toggle} onOpen={()=>{}} onDelete={()=>{}} scrollMemoryKey={'fixture-actress:'+filter}/>}
 </div></div>}
window.__scroller=()=>Array.from(document.querySelectorAll('#grid-host *')).find(el=>['auto','scroll'].includes(getComputedStyle(el).overflowY)&&el.clientHeight>0&&el.scrollHeight>el.clientHeight);
window.__layout=()=>{const cells=Array.from(document.querySelectorAll('.grid-poster-cell,.virtual-actress-grid-cell'));return{columns:new Set(cells.map(el=>el.style.left)).size,rowHeight:parseFloat(cells[0].style.height)}};
window.__scroll=(index)=>{const {columns,rowHeight}=window.__layout();window.__scroller().scrollTop=Math.floor(index/columns)*rowHeight};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><MemoryRouter><App/></MemoryRouter></QueryClientProvider>);
`)
let server, browser, activePage
const results = []
try {
  server = await createServer({ configFile: false, root, cacheDir: path.join(root, '.vite'), plugins: [react(), {
    name: 'synthetic-images', transform(code, id) {
      if (id === path.join(repo, 'src/renderer/src/api.ts')) return code.replace('const url = `media://${normalized}`', "const url = '/image.svg?path=' + encodeURIComponent(normalized)")
    }
  }], resolve: { alias: { '@shared': path.join(repo, 'src/shared'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom'), 'react-router-dom': path.join(repo, 'node_modules/react-router-dom'), '@tanstack/react-query': path.join(repo, 'node_modules/@tanstack/react-query'), 'react-window': path.join(repo, 'node_modules/react-window') } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, repo] } } })
  await server.listen()
  browser = await chromium.launch({ channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome', headless: true })
  for (const viewport of [{ width: 1000, height: 640 }, { width: 1440, height: 900 }]) for (const kind of ['video', 'actress']) {
    const page = activePage = await browser.newPage({ viewport }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?kind=${kind}`)
    await page.waitForFunction(() => window.__result?.window.getItem(0)?.id === 1 && window.__scroller())
    const pageSize = await page.evaluate(() => window.__pageSize)
    const initialHeight = await page.evaluate(() => window.__scroller().scrollHeight)
    const selectedLabel = kind === 'video' ? 'VIDEO-' : 'ACTRESS-'
    await page.getByRole('button', { name: `选择 ${selectedLabel}1`, exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.__selections.at(-1)), { id: 1, index: 0 })
    let maxCache = 0, maxRetained = 0
    for (let n = 1; n < 100; n++) {
      const index = n * pageSize + 20
      await page.evaluate(index => window.__scroll(index), index)
      await page.waitForFunction(index => window.__result.window.getItem(index)?.id === index + 1, index)
      await page.waitForFunction(() => window.__client.getQueryCache().getAll().length <= 3)
      const state = await page.evaluate(() => ({ cache: window.__client.getQueryCache().getAll().length, retained: window.__result.items.length, height: window.__scroller().scrollHeight }))
      maxCache = Math.max(maxCache, state.cache); maxRetained = Math.max(maxRetained, state.retained)
      assert.ok(state.retained <= 3 * pageSize); assert.equal(state.height, initialHeight)
    }
    assert.equal(await page.evaluate(() => window.__result.window.getItem(0)), undefined)
    const absoluteIndex = 99 * pageSize + 20
    await page.getByRole('button', { name: `选择 ${selectedLabel}${absoluteIndex + 1}`, exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.__selections.at(-1)), { id: absoluteIndex + 1, index: absoluteIndex })
    await page.evaluate(() => window.__scroll(0))
    await page.waitForFunction(() => window.__result.window.getItem(0)?.id === 1)
    await page.getByRole('button', { name: `取消选择 ${selectedLabel}1`, exact: true }).waitFor()
    assert.ok(await page.evaluate(() => window.__calls.filter(call => call.offset === 0).length >= 2))
    const failedIndex = 110 * pageSize + 20
    await page.evaluate(index => { window.__failOffset = Math.floor(index / window.__pageSize) * window.__pageSize; window.__scroll(index) }, failedIndex)
    await page.getByRole('button', { name: '加载失败，重试', exact: true }).first().waitFor()
    assert.equal(await page.evaluate(() => window.__scroller().scrollHeight), initialHeight)
    await page.screenshot({ path: path.join(output, `${kind}-${viewport.width}x${viewport.height}-failure.png`) })
    await page.getByRole('button', { name: '加载失败，重试', exact: true }).first().click()
    await page.waitForFunction(index => !window.__result.window.error && window.__result.window.getItem(index)?.id === index + 1, failedIndex)
    for (let n = 0; n < 20; n++) {
      await page.getByLabel('Fixture filter').fill(`filter-${n}`)
      await page.waitForFunction(n => window.__filter === `filter-${n}` && window.__result.window.getItem(0)?.id === 1 && (window.__result.window.getItem(0).title ?? window.__result.window.getItem(0).main_name).endsWith('filter-'+n), n)
      await page.waitForFunction(() => window.__client.getQueryCache().getAll().length <= 3)
    }
    const geometry = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth > innerWidth,
      bottom: window.__scroller().getBoundingClientRect().bottom, viewport: innerHeight,
      cards: document.querySelectorAll('.grid-poster-cell,.virtual-actress-grid-cell').length,
      cache: window.__client.getQueryCache().getAll().length, scrollTop: window.__scroller().scrollTop }))
    assert.equal(geometry.horizontal, false); assert.ok(geometry.bottom <= geometry.viewport + 1)
    assert.ok(geometry.cards < 100); assert.ok(geometry.cache <= 3); assert.equal(geometry.scrollTop, 0)
    await page.screenshot({ path: path.join(output, `${kind}-${viewport.width}x${viewport.height}.png`) })
    assert.deepEqual(errors, [])
    results.push({ kind, viewport, pages: 100, filters: 20, maxCache, maxRetained, pageSize, initialHeight, geometry,
      evictionSelectionPassed: true, absoluteIndexPassed: true, oldPageReloadPassed: true, errorGeometryRetryPassed: true, errors,
      calls: await page.evaluate(() => window.__calls) })
    await page.close(); activePage = undefined
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(output)
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), completed: results }, null, 2))
  throw error
} finally {
  await browser?.close(); await server?.close()
  if (!output.startsWith(root + path.sep)) fs.rmSync(root, { recursive: true, force: true })
}
