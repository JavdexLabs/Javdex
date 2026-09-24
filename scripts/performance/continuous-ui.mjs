/** Actual shared components, synthetic pages. No user database or media. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
const repo = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-continuous-ui-'))
const local = file => JSON.stringify('/@fs/' + path.join(repo, file).replaceAll('\\', '/'))
fs.writeFileSync(path.join(root, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root, 'fixture.jsx'), `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
import ${local('apps/desktop/src/renderer/src/styles/global.css')};
import Grid from ${local('apps/desktop/src/renderer/src/components/ContinuousGrid.tsx')};

import Modal from ${local('apps/desktop/src/renderer/src/components/Modal.tsx')};
import {ToastProvider} from ${local('apps/desktop/src/renderer/src/components/Toast.tsx')};
import {useContinuousPage} from ${local('apps/desktop/src/renderer/src/hooks/useContinuousPage.ts')};
window.React=React;window.api={playlists:{listPage:async q=>({items:Array.from({length:60},(_,i)=>({id:q.offset+i+1,name:'旅行影像与纪录片精选 — 长名称布局检查 '+(q.offset+i+1),preview_cover_path:null,video_count:12})),total:7500,offset:q.offset,hasExactName:false})}};const PlaylistPicker=(await import(${local('apps/desktop/src/renderer/src/components/PlaylistVideoPicker.tsx')})).default;const Destination=(await import(${local('apps/desktop/src/renderer/src/components/PlaylistDestinationPicker.tsx')})).default;const Posters=(await import(${local('apps/desktop/src/renderer/src/components/ContinuousPosterGrid.tsx')})).default;const visual=new URLSearchParams(location.search).get('visual'); const kind=new URLSearchParams(location.search).get('kind'), size=60;
function App(){const [filter,setFilter]=useState('initial'),[selection,setSelection]=useState(new Set());
const result=useContinuousPage(filter, size,async offset=>{if(window.__hold===offset){window.__hold=null;await new Promise(resolve=>window.__resume=resolve)}if(window.__fail===offset){window.__fail=null;throw Error('读取失败测试')}return {items:Array.from({length:Math.min(size,7500-offset)},(_,i)=>({id:offset+i+1})),total:7500}});
window.__result=result;window.__select=selection;window.__filter=setFilter;
return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><input aria-label="筛选" value={filter} onChange={e=>setFilter(e.target.value)}/><div id="scroll" style={{overflow:'auto',flex:1,minHeight:0,padding:20}}>
{kind==='external'&&<div style={{height:250}}>资料区</div>}
<Grid contained={kind==='contained'} window={result.window} scope={filter} label="候选" minWidth={kind==='rows'?0:180} itemHeight={kind==='rows'?44:180} itemKey={item=>item.id} renderItem={item=><button style={{height:'100%',border:'1px solid var(--border-subtle)',background:'var(--surface-panel)'}} aria-pressed={selection.has(item.id)} onClick={()=>setSelection(old=>{const next=new Set(old);next.has(item.id)?next.delete(item.id):next.add(item.id);return next})}>条目 {item.id}</button>}/></div></div>}
function Visual(){const[value,setValue]=useState(''),[label,setLabel]=useState('');return <Modal title="选择目标清单" onCancel={()=>{}} onConfirm={()=>{}} size="md"><Destination value={value} label={label} onChange={(id,name)=>{setValue(id);setLabel(name)}}/></Modal>}
function VisualDetail(){const result=useContinuousPage('detail',60,async offset=>({total:7500,items:Array.from({length:60},(_,i)=>({id:offset+i+1,code:'FILM-'+(offset+i+1),title:'山川之间 — 长片名与多行标题布局检查',cover_path:null,scraped_status:1,resource_kinds:[]}))}));return <MemoryRouter><div id="detail-scroll" style={{height:'100vh',overflow:'auto',padding:32}}><section style={{minHeight:220}}><h2>示例清单</h2><p>7,500 部影片 · 验证资料区和影片使用同一滚动容器。</p></section><Posters window={result.window} scope="visual-detail"/></div></MemoryRouter>}
createRoot(document.getElementById('root')).render(visual==='playlist'?<ToastProvider><PlaylistPicker videoIds={[1]} subtitle='1 部' onCancel={()=>{}}/></ToastProvider>:visual==='detail'?<VisualDetail/>:visual?<Visual/>:<App/>);
window.__scroller=()=>kind==='contained'?document.querySelector('[aria-label="候选"]').parentElement:document.querySelector('#scroll');
window.__scroll=index=>{const grid=document.querySelector('[aria-label="候选"]'),cells=[...grid.querySelectorAll('[data-index]')];const columns=kind==='rows'?1:Math.max(1,Math.floor((grid.clientWidth+12)/192));window.__scroller().scrollTop=(kind==='external'?250:0)+Math.floor(index/columns)*(kind==='rows'?48:192)};
`)
let server, browser
const results=[]
try {
 server=await createServer({configFile:false,root,cacheDir:path.join(root,'.vite'),plugins:[react()],resolve:{alias:{'@shared':path.join(repo,'packages/contracts/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom'),'react-router-dom':path.join(repo,'node_modules/react-router-dom')}},server:{host:'127.0.0.1',port:4330,fs:{allow:[root,repo]}}});await server.listen()
 browser=await chromium.launch({channel:'chrome',headless:true})
 for(const viewport of [{width:1000,height:640},{width:1440,height:900}])for(const kind of ['external','contained','rows']){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?kind=${kind}`)
  await page.getByRole('button',{name:'条目 1',exact:true}).waitFor();await page.getByRole('button',{name:'条目 1',exact:true}).click()
  let maxRetained=0,maxDom=0
  for(let n=1;n<100;n++){
   const index=n*60+20;await page.evaluate(index=>window.__scroll(index),index)
   await page.waitForFunction(index=>window.__result.window.getItem(index)?.id===index+1,index)
   const state=await page.evaluate(()=>({retained:window.__result.items.length,dom:document.querySelectorAll('[data-index]').length}));maxRetained=Math.max(maxRetained,state.retained);maxDom=Math.max(maxDom,state.dom);assert.ok(state.retained<=180);assert.ok(state.dom<100)
  }
  assert.equal(await page.evaluate(()=>window.__result.window.getItem(0)),undefined)
  await page.evaluate(()=>window.__scroll(0));await page.getByRole('button',{name:'条目 1',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'条目 1',exact:true}).getAttribute('aria-pressed'),'true')
  await page.evaluate(()=>{window.__fail=6600;window.__scroll(6620)});await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>window.__result.window.getItem(6620)?.id===6621)
  await page.evaluate(()=>window.__scroll(0));await page.getByRole('button',{name:'条目 1',exact:true}).focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.activeElement?.textContent==='条目 2')
  await page.evaluate(()=>{window.__hold=60;window.__filter('keyboard')});await page.getByRole('button',{name:'条目 1',exact:true}).waitFor()
  await page.evaluate(()=>window.__scroll(55));await page.getByRole('button',{name:'条目 60',exact:true}).focus();assert.equal(await page.evaluate(()=>window.__result.window.getItem(60)),undefined);await page.keyboard.press('ArrowRight');assert.notEqual(await page.evaluate(()=>document.activeElement?.textContent),'条目 61');await page.evaluate(()=>window.__resume());await page.waitForFunction(()=>document.activeElement?.textContent==='条目 61')
  const before=await page.evaluate(kind=>{const g=document.querySelector('[aria-label="候选"]');const columns=kind==='rows'?1:Math.max(1,Math.floor((g.clientWidth+12)/192));const top=Math.max(0,window.__scroller().getBoundingClientRect().top-g.getBoundingClientRect().top);return Math.floor(top/(kind==='rows'?48:192))*columns},kind)
  await page.setViewportSize({width:viewport.width===1000?1440:1000,height:viewport.height});await page.waitForTimeout(80)
  const after=await page.evaluate(kind=>{const g=document.querySelector('[aria-label="候选"]');const columns=kind==='rows'?1:Math.max(1,Math.floor((g.clientWidth+12)/192));const top=Math.max(0,window.__scroller().getBoundingClientRect().top-g.getBoundingClientRect().top);return {index:Math.floor(top/(kind==='rows'?48:192))*columns,columns}},kind)
  assert.ok(Math.abs(after.index-before)<after.columns,`resize anchor: ${before} -> ${after.index}`)
  await page.setViewportSize(viewport)
  await page.evaluate(()=>window.__scroll(0))
  for(let n=0;n<20;n++){await page.evaluate(value=>window.__filter(value),String(n));await page.waitForFunction(()=>window.__result.window.getItem(0)?.id===1)}
  assert.deepEqual(errors,[]);results.push({kind,viewport,maxRetained,maxDom});await page.close()
 }
 for(const viewport of [{width:1000,height:640},{width:1440,height:900}]){
  const page=await browser.newPage({viewport});await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?visual=picker`)
  await page.locator('.playlist-pick-row').first().waitFor()
  const picker=await page.evaluate(()=>{
   const grid=document.querySelector('[aria-label="目标清单"]'), view=grid.parentElement
   const rows=[...document.querySelectorAll('.playlist-pick-row')].map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,height:el.getBoundingClientRect().height}))
   return {rows,gap:rows[1].top-rows[0].bottom,overflow:view.scrollWidth>view.clientWidth}
  })
  assert.ok(picker.rows.every(row=>Math.abs(row.height-86)<1));assert.ok(Math.abs(picker.gap-8)<1);assert.equal(picker.overflow,false)
  await page.getByRole('button',{name:/旅行影像/}).first().click();await page.screenshot({path:path.join(repo,`out/continuous-picker-${viewport.width}.png`)})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?visual=playlist`)
  await page.locator('.playlist-pick-row').first().waitFor()
  const boxes=await page.evaluate(()=>{
   const grid=document.querySelector('[aria-label="清单候选"]'), view=grid.parentElement, panel=document.querySelector('.playlist-pick-panel');
   const rows=[...document.querySelectorAll('.playlist-pick-row')].map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,height:el.getBoundingClientRect().height}));
   return {rows,gap:rows[1].top-rows[0].bottom,bottom:panel.getBoundingClientRect().bottom-view.getBoundingClientRect().bottom,overflow:view.scrollWidth>view.clientWidth}
  })
  assert.ok(boxes.rows.every(row=>Math.abs(row.height-86)<1));assert.ok(Math.abs(boxes.gap-8)<1);assert.ok(Math.abs(boxes.bottom)<2);assert.equal(boxes.overflow,false)
  await page.screenshot({path:path.join(repo,`out/continuous-playlist-${viewport.width}.png`)})
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?visual=detail`)
  await page.locator('[data-index="0"]').waitFor();await page.screenshot({path:path.join(repo,`out/continuous-detail-${viewport.width}.png`)})
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#detail-scroll *')].filter(el=>['auto','scroll'].includes(getComputedStyle(el).overflowY)&&el.scrollHeight>el.clientHeight).length),0)
  await page.close()
 }
 console.log(JSON.stringify(results,null,2))
} finally {await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true})}
