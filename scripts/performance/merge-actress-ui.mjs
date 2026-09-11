/** Actual merge modal and styles, synthetic IPC, no user database. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {chromium} from 'playwright-core'
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-merge-ui-'))
const output=path.resolve(process.env.JAVDEX_MERGE_UI_OUTPUT??path.join(root,'results'));fs.mkdirSync(output,{recursive:true})
fs.writeFileSync(path.join(root,'index.html'),'<html><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root,'fixture.jsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';
import ${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/styles/global.css'))};
window.React=React;window.__calls=[];window.__merges=[];window.__merged=0;window.__cancelled=0;
window.api={actresses:{list:()=>{throw new Error('Full actress list forbidden')},mergeCandidates:async query=>{
 window.__calls.push(query);if(window.__failPage){window.__failPage=false;throw new Error('Page failure')}
 const all=Array.from({length:101},(_,i)=>({id:i+2,main_name:'Candidate-'+(i+2),gender:'female',avatar_path:null,video_count:i+1})).filter(item=>!query.search||item.main_name.includes(query.search));
 return {items:all.slice(query.offset,query.offset+40),hasMore:all.length>query.offset+40,offset:query.offset}
},merge:async input=>{window.__merges.push(input);if(window.__holdMerge)await new Promise(resolve=>{window.__releaseMerge=resolve});if(window.__failMerge){window.__failMerge=false;throw new Error('Merge failure')}return true}}};
const Component=(await import(${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/components/MergeActressModal.tsx'))})).default;
createRoot(document.getElementById('root')).render(<Component keepVideoCount={0} keepActress={{id:1,main_name:'Keep-1',gender:'female',avatar_path:null,videos:[],gallery:[]}} onCancel={()=>window.__cancelled++} onMerged={()=>window.__merged++}/>);
`)
let server,browser;const results=[]
try {
 server=await createServer({configFile:false,root,cacheDir:path.join(root,'.vite'),plugins:[react()],resolve:{alias:{
  '@shared':path.join(repo,'src/shared'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom'),
  'react-router-dom':path.join(repo,'node_modules/react-router-dom'),'@tanstack/react-query':path.join(repo,'node_modules/@tanstack/react-query')
 }},server:{host:'127.0.0.1',port:0,fs:{allow:[root,repo]}}})
 await server.listen();browser=await chromium.launch({channel:process.env.JAVDEX_BROWSER_CHANNEL||'chrome',headless:true})
 for(const viewport of [{width:1000,height:640},{width:1440,height:900}]) {
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port)
  await page.getByRole('option',{name:'选择合并演员 Candidate-2',exact:true}).click()
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}-selected.png`)})
  const layout=await page.evaluate(()=>{
    const flow=document.querySelector('.merge-actress-flow').getBoundingClientRect(),picker=document.querySelector('.merge-actress-picker').getBoundingClientRect(),plan=document.querySelector('.merge-actress-plan').getBoundingClientRect();
    return {flowBottom:flow.bottom,pickerTop:picker.top,pickerBottom:picker.bottom,planTop:plan.top}
  })
  assert.ok(layout.flowBottom<=layout.pickerTop && layout.pickerBottom<=layout.planTop,'Preview, picker and plan must not overlap')
  const pager=page.getByLabel('合并候选分页',{exact:true})
  await pager.scrollIntoViewIfNeeded()
  const firstPager=await pager.boundingBox();assert.ok(firstPager&&firstPager.y>=0&&firstPager.y+firstPager.height<=viewport.height)
  await page.getByText('使用对方主名',{exact:true}).click()
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('option',{name:'选择合并演员 Candidate-42',exact:true}).waitFor()
  assert.equal(await page.getByRole('option').count(),40)
  assert.equal(await page.getByRole('radio',{name:/使用对方主名/}).isChecked(),true)
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('option',{name:'选择合并演员 Candidate-82',exact:true}).waitFor();assert.equal(await page.getByRole('option').count(),21)
  await page.evaluate(()=>{window.__failPage=true});await page.getByRole('button',{name:'上一页',exact:true}).click()
  await page.getByText('合并候选读取失败',{exact:true}).waitFor();await page.getByRole('button',{name:'重试',exact:true}).click()
  await page.getByRole('option',{name:'选择合并演员 Candidate-42',exact:true}).waitFor()
  await page.getByRole('searchbox',{name:'搜索合并候选'}).fill('Candidate-100')
  await page.getByRole('option',{name:'选择合并演员 Candidate-100',exact:true}).waitFor();assert.equal(await page.getByRole('option').count(),1)
  await page.getByRole('searchbox',{name:'搜索合并候选'}).fill('')
  await page.getByRole('option',{name:'选择合并演员 Candidate-2',exact:true}).waitFor()
  assert.equal(await page.getByRole('option',{name:'选择合并演员 Candidate-2',exact:true}).getAttribute('aria-selected'),'true')
  await page.evaluate(()=>{window.__failMerge=true});await page.getByRole('button',{name:'确认合并',exact:true}).click()
  await page.getByText('Merge failure',{exact:true}).waitFor()
  const errorBox=await page.getByText('Merge failure',{exact:true}).boundingBox()
  const submitBox=await page.getByRole('button',{name:'确认合并',exact:true}).boundingBox()
  assert.ok(errorBox&&submitBox&&errorBox.y>=0&&errorBox.y+errorBox.height<=submitBox.y,'Merge failure must be visible above the fixed actions')
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}.png`)})
  await page.evaluate(()=>{window.__holdMerge=true});await page.getByRole('button',{name:'确认合并',exact:true}).click()
  await page.waitForFunction(()=>typeof window.__releaseMerge==='function')
  assert.equal(await page.getByRole('searchbox',{name:'搜索合并候选'}).isDisabled(),true)
  assert.equal(await page.getByRole('radio',{name:/使用对方主名/}).isDisabled(),true)
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.__cancelled),0)
  await page.evaluate(()=>window.__releaseMerge());await page.waitForFunction(()=>window.__merged===1)
  assert.deepEqual(await page.evaluate(()=>window.__merges),[{keepId:1,mergeId:2,mainNameFrom:'merge'},{keepId:1,mergeId:2,mainNameFrom:'merge'}])
  const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}))
  assert.ok(geometry.scrollWidth<=geometry.width+1);assert.deepEqual(errors,[])
  results.push({viewport,geometry,layout,firstPager,errorBox,submitBox,queries:await page.evaluate(()=>window.__calls),merges:await page.evaluate(()=>window.__merges),errors});await page.close()
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results))
}finally{await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true})}
