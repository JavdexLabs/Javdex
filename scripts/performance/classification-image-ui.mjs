/** Actual image editor, privacy provider and styles, with synthetic API/local SVG. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import{createServer}from'vite'
import react from '@vitejs/plugin-react'
import{chromium}from'playwright-core'
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-image-editor-ui-')),output=path.resolve(process.env.JAVDEX_IMAGE_EDITOR_UI_OUTPUT??path.join(root,'results'));fs.mkdirSync(output,{recursive:true})
const local=p=>JSON.stringify('/@fs/'+path.join(repo,p).replaceAll('\\','/'))
fs.writeFileSync(path.join(root,'index.html'),'<html><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root,'image.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#334455"/><circle cx="320" cy="200" r="100" fill="#889aab"/></svg>')
fs.writeFileSync(path.join(root,'fixture.jsx'),`
import React,{useState}from'react';import{createRoot}from'react-dom/client';import ${local('src/renderer/src/styles/global.css')};
window.React=React;window.__calls=[];window.__saves=[];window.__cancelled=0;
window.api={settings:{get:async()=>({theme:'graphite',privacyModeEnabled:false,privacyModeScopes:['mediaEditors']})},classificationImages:{candidates:()=>{throw Error('Full candidates forbidden')},page:async(entity,q)=>{window.__calls.push({entity,q});if(window.__fail){window.__fail=false;throw Error('Page failed')}if(window.__hold){window.__hold=false;await new Promise(resolve=>window.__release=resolve)}return {items:Array.from({length:Math.min(60,Math.max(0,125-q.offset))},(_,n)=>({videoId:q.offset+n+1,code:'CODE-'+(q.offset+n+1),title:null,coverPath:'covers/'+(q.offset+n+1)+'.jpg'})),offset:q.offset,total:125,limit:60}},set:async(entity,input)=>{window.__saves.push({entity,input});return{imagePath:'saved.jpg',cleanupFailures:[]}}}};
const Component=(await import(${local('src/renderer/src/components/ClassificationImageModal.tsx')})).default;
const {ThemeProvider,useTheme}=await import(${local('src/renderer/src/components/ThemeProvider.tsx')});
function Editor(){const theme=useTheme();window.__privacy=enabled=>theme.syncPrivacyMode({privacyModeEnabled:enabled,privacyModeScopes:['mediaEditors']});const [entity,setEntity]=useState({kind:'director',id:1});window.__entity=setEntity;return <Component entity={entity} entityLabel="导演" imagePath="current.jpg" fallbackCoverPath={null} onCancel={()=>window.__cancelled++} onChanged={()=>{}}/>}
createRoot(document.getElementById('root')).render(<ThemeProvider><Editor/></ThemeProvider>);
`)
let server,browser;const results=[]
try{
 const apiFile=path.join(repo,'src/renderer/src/api.ts').replaceAll('\\','/')
 server=await createServer({configFile:false,root,cacheDir:path.join(root,'.vite'),plugins:[react(),{name:'synthetic-media',transform(code,id){if(id.replaceAll('\\','/')===apiFile)return code.replace('const url = `media://${normalized}`',"const url = '/image.svg?path=' + encodeURIComponent(normalized)")}}],resolve:{alias:{'@shared':path.join(repo,'src/shared'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')}},server:{host:'127.0.0.1',port:0,fs:{allow:[repo,root]}}})
 await server.listen();browser=await chromium.launch({channel:process.env.JAVDEX_BROWSER_CHANNEL||'chrome',headless:true})
 for(const viewport of [{width:1000,height:640},{width:1440,height:900}]){
  const page=await browser.newPage({viewport}),errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/image.svg?'))requests.push(request.url())})
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port)
  await page.getByRole('tab',{name:'影片封面'}).waitFor();assert.equal(await page.evaluate(()=>window.__calls.length),0)
  await page.getByRole('tab',{name:'图片链接'}).click();assert.equal(await page.evaluate(()=>window.__calls.length),0)
  await page.evaluate(()=>window.__privacy(true));await page.getByText('隐私模式已隐藏媒体编辑',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__calls.length),0)
  await page.evaluate(()=>window.__privacy(false));  await page.getByRole('tab',{name:'影片封面'}).click()
  const candidates=page.locator('button[aria-label^="CODE-"]'),strip=page.locator('[role=tabpanel][data-active=true]')
  await page.waitForFunction(()=>document.querySelectorAll('button[aria-label^="CODE-"]').length===60)
  await page.getByRole('button',{name:'CODE-1',exact:true}).click()
  await strip.evaluate(el=>{el.scrollLeft=el.scrollWidth});await page.getByRole('button',{name:'CODE-61',exact:true}).waitFor()
  await page.evaluate(()=>window.__fail=true);await strip.evaluate(el=>{el.scrollLeft=el.scrollWidth});await page.getByRole('button',{name:'重试'}).click()
  await page.getByRole('button',{name:'CODE-121',exact:true}).waitFor();assert.ok((await candidates.count())<=180)
  assert.ok((await page.locator('.classification-image-preview img').getAttribute('src')).includes('covers%2F1.jpg'))
  await strip.evaluate(el=>{el.scrollLeft=0});await page.getByRole('button',{name:'CODE-1',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'CODE-1',exact:true}).getAttribute('aria-pressed'),'true')
  const geometry=await strip.evaluate(el=>{const save=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存主图');return {panel:el.getBoundingClientRect().toJSON(),save:save.getBoundingClientRect().toJSON(),stripScroll:el.scrollWidth>el.clientWidth,horizontal:document.documentElement.scrollWidth>innerWidth}})
  assert.ok(geometry.stripScroll);assert.ok(geometry.save.bottom<=viewport.height);assert.ok(geometry.panel.bottom<=geometry.save.top);assert.equal(geometry.horizontal,false)
  await page.waitForFunction(()=>{const img=document.querySelector('.classification-image-preview img');return img.complete&&img.naturalWidth>0})
  await page.screenshot({path:path.join(output,viewport.width+'x'+viewport.height+'.png')})
  await page.getByRole('button',{name:'保存主图',exact:true}).click();await page.waitForFunction(()=>window.__saves.length===1)
  assert.deepEqual(await page.evaluate(()=>window.__saves[0]),{entity:{kind:'director',id:1},input:{source:'video-cover',videoId:1}})
  await page.evaluate(()=>{window.__hold=true;window.__entity({kind:'director',id:9})});await page.getByRole('tab',{name:'影片封面'}).click();await page.waitForFunction(()=>typeof window.__release==='function')
  await page.evaluate(()=>window.__privacy(true));await page.getByText('隐私模式已隐藏媒体编辑',{exact:true}).waitFor();await page.evaluate(()=>window.__release());const beforeResume=await page.evaluate(()=>window.__calls.length);await page.evaluate(()=>window.__privacy(false))
  await page.getByRole('button',{name:'CODE-1',exact:true}).waitFor();assert.equal(await candidates.count(),60);assert.ok(await page.evaluate(before=>window.__calls.length>=before,beforeResume));await page.getByRole('button',{name:'CODE-1',exact:true}).click();assert.ok((await page.locator('.classification-image-preview img').getAttribute('src')).includes('covers%2F1.jpg'))
  await page.evaluate(()=>window.__entity({kind:'series',id:2}));await page.getByRole('tab',{name:'本地图片'}).waitFor();assert.equal(await page.getByRole('button',{name:'保存主图',exact:true}).isDisabled(),true)
  assert.ok(requests.some(value=>{const url=new URL(value);return url.searchParams.get('path')==='covers/1.jpg'&&url.searchParams.get('size')==='320'}));assert.ok(requests.some(value=>{const url=new URL(value);return url.searchParams.get('path')==='covers/1.jpg'&&!url.searchParams.has('size')}))
  assert.deepEqual(errors,[]);results.push({viewport,geometry,calls:await page.evaluate(()=>window.__calls),requests,errors});await page.close()
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(output)
}finally{await browser?.close();await server?.close();if(!output.startsWith(root+path.sep))fs.rmSync(root,{recursive:true,force:true})}
