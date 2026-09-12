/** Actual plugin target picker and styles, synthetic IPC, no user database. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {chromium} from 'playwright-core'
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-plugin-target-ui-'))
const output=path.resolve(process.env.JAVDEX_PLUGIN_TARGET_UI_OUTPUT??path.join(root,'results'));fs.mkdirSync(output,{recursive:true})
fs.writeFileSync(path.join(root,'index.html'),'<html><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root,'fixture.jsx'),`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import ${JSON.stringify('/@fs'+path.join(repo,'apps/desktop/src/renderer/src/styles/global.css'))};
window.React=React;window.__calls=[];window.__added=[];window.__closed=0;
const all=Array.from({length:101},(_,i)=>({id:i+1,main_name:i===0?'A'.repeat(128)+'…':'Candidate-'+String(i+1).padStart(3,'0'),avatar_path:null}));
window.api={actresses:{list:()=>{throw new Error('Full actors forbidden')},testTargetPage:async query=>{window.__calls.push(query);if(window.__failPage){window.__failPage=false;throw new Error('Page failed')}const rows=all.filter(item=>!query.search||item.main_name.includes(query.search));return {items:rows.slice(query.offset,query.offset+40),offset:query.offset,hasMore:rows.length>query.offset+40}},testTargetGet:async id=>{if(window.__hold)await new Promise(resolve=>window.__release=resolve);if(window.__missing)return null;return id===1?'A'.repeat(150):all[id-1].main_name}}};
const Component=(await import(${JSON.stringify('/@fs'+path.join(repo,'apps/desktop/src/renderer/src/components/pluginDev/PluginDevMediaTargetPicker.tsx'))})).default;
function App(){const[values,setValues]=useState([]),[open,setOpen]=useState(true);return open?<Component kind="actress" selectedValues={values} onAdd={value=>{window.__added.push(value);setValues(old=>[...old,value])}} onClose={()=>{window.__closed++;setOpen(false)}}/>:<button onClick={()=>setOpen(true)}>重新打开</button>}
createRoot(document.getElementById('root')).render(<App/>);
`)
let server,browser;const results=[]
try {
 server=await createServer({configFile:false,root,cacheDir:path.join(root,'.vite'),plugins:[react()],resolve:{alias:{
  '@shared':path.join(repo,'packages/contracts/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom'),
  'react-router-dom':path.join(repo,'node_modules/react-router-dom'),'@tanstack/react-query':path.join(repo,'node_modules/@tanstack/react-query')
 }},server:{host:'127.0.0.1',port:0,fs:{allow:[root,repo]}}})
 await server.listen();browser=await chromium.launch({channel:process.env.JAVDEX_BROWSER_CHANNEL||'chrome',headless:true})
 for(const viewport of [{width:1000,height:640},{width:1440,height:900}]) {
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0]);const rows=page.locator('.plugin-dev-target-picker-row')
  await page.waitForFunction(()=>document.querySelectorAll('.plugin-dev-target-picker-row').length===40)
  const rowGeometry=await page.evaluate(()=>Array.from(document.querySelectorAll('.plugin-dev-target-picker-row')).slice(0,5).map(row=>{const r=row.getBoundingClientRect(),a=row.querySelector('.plugin-dev-target-picker-avatar').getBoundingClientRect();return {rowTop:r.top,rowBottom:r.bottom,avatarTop:a.top,avatarBottom:a.bottom,avatarWidth:a.width,avatarRadius:getComputedStyle(row.querySelector('.plugin-dev-target-picker-avatar')).borderRadius}}))
  for(const item of rowGeometry){assert.ok(item.avatarTop>=item.rowTop&&item.avatarBottom<=item.rowBottom,'avatar must fit its candidate row');assert.equal(item.avatarRadius,'50%','actor avatar must remain circular')}

  await rows.first().click();await page.waitForFunction(()=>window.__added.length===1)
  assert.equal(await page.evaluate(()=>window.__added[0]),'A'.repeat(150))
  await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.plugin-dev-target-picker-row')?.textContent.includes('Candidate-041'))
  await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.plugin-dev-target-picker-row').length===21)
  await page.getByRole('button',{name:'上一页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.plugin-dev-target-picker-row')?.textContent.includes('Candidate-041'))
  await page.getByRole('button',{name:'上一页',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.plugin-dev-target-picker-row')?.disabled)
  const search=page.getByRole('textbox',{name:'搜索测试目标'})
  await search.fill('Candidate-100');await page.waitForFunction(()=>document.querySelectorAll('.plugin-dev-target-picker-row').length===1)
  await search.fill('');await page.waitForFunction(()=>document.querySelectorAll('.plugin-dev-target-picker-row').length===40)
  await page.evaluate(()=>window.__failPage=true);await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.plugin-dev-target-picker-row').length===40)
  await page.evaluate(()=>window.__missing=true);await rows.first().click();await page.getByRole('alert').waitFor()
  const pager=await page.locator('.plugin-dev-target-picker-pagination').boundingBox();assert.ok(pager&&pager.y>=0&&pager.y+pager.height<=viewport.height)
  const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));assert.equal(geometry.width,geometry.scrollWidth)
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}-error.png`)})
  await page.evaluate(()=>{window.__missing=false;window.__hold=true});await rows.first().click()
  await page.getByRole('button',{name:'完成',exact:true}).click();await page.evaluate(()=>window.__release());await page.waitForTimeout(20)
  assert.equal(await page.evaluate(()=>window.__added.length),1);assert.deepEqual(errors,[])
  await page.evaluate(()=>window.__hold=false);await page.getByRole('button',{name:'重新打开'}).click()
  await page.waitForFunction(()=>document.querySelector('.plugin-dev-target-picker-row')?.classList.contains('is-selected'))
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}.png`)})

  results.push({viewport,geometry,pager,rowGeometry,calls:await page.evaluate(()=>window.__calls),errors});await page.close()
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
}finally{await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true})}
