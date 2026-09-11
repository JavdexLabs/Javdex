/** Actual avatar log modal and styles, synthetic progress, no user database. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {chromium} from 'playwright-core'
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-avatar-log-ui-'))
const output=path.resolve(process.env.JAVDEX_AVATAR_LOG_UI_OUTPUT??path.join(root,'results'));fs.mkdirSync(output,{recursive:true})
fs.writeFileSync(path.join(root,'index.html'),'<html><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(root,'fixture.jsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';
import ${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/styles/global.css'))};
window.React=React;window.api={};
const Panel=(await import(${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/components/settings/BatchSettingsPanel.tsx'))})).default;
const Modal=(await import(${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/components/Modal.tsx'))})).default;
const {appendAvatarLog,avatarLogNotice}=await import(${JSON.stringify('/@fs'+path.join(repo,'src/renderer/src/avatarAutoCrop/logs.ts'))});
let state={logs:[],totalLogCount:0,shortenedLogCount:0};for(let i=0;i<500;i++)state=appendAvatarLog(state,{time:new Date(0).toISOString(),code:'演员-'+i,message:'诊断'.repeat(2000),level:'error'});
createRoot(document.getElementById('root')).render(<Modal title="头像构图任务" size="xl" className="modal--batch-detail" bodyClassName="modal-body--batch-detail" hideActions onCancel={()=>{}}><Panel scope="avatar" batch={{total:500,current:500,success:0,failed:500,pending:0,currentCode:null,status:'done',logs:state.logs}} running={false} paused={false} logRef={React.createRef()} emptyLog="无日志" logNotice={avatarLogNotice(state)} onPause={()=>{}} onResume={()=>{}} onDiscard={()=>{}} /></Modal>);
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
  await page.goto(server.resolvedUrls.local[0]);await page.locator('.log-line').first().waitFor()
  assert.equal(await page.locator('.log-line').count(),200)
  const notice=page.getByText(/已省略 300 条较早日志/)
  await notice.scrollIntoViewIfNeeded();assert.equal(await notice.isVisible(),true)
  const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}))
  assert.equal(geometry.width,geometry.scrollWidth);assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(output,`${viewport.width}x${viewport.height}.png`)})
  results.push({viewport,geometry,notice:await notice.textContent(),errors});await page.close()
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
}finally{await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true})}
