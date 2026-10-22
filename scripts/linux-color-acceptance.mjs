import { nativeViewportProbe, installNativeViewportProbe } from './linux-native-viewport-probe.mjs'
// Final package, disposable synthetic catalog; readback only after settling.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chromium} from 'playwright-core'
import sharp from 'sharp'
import {seedAcceptanceCatalog} from './playback-acceptance-support.mjs'
const [imageArg,mediaArg,outputArg,display,mode]=process.argv.slice(2)
assert(imageArg&&mediaArg&&outputArg,'Usage: node scripts/linux-color-acceptance.mjs APPIMAGE FIXTURES NEW_OUTPUT wayland|x11 gpu|cpu')
assert(['wayland','x11'].includes(display)&&['gpu','cpu'].includes(mode))
const image=path.resolve(imageArg),output=path.resolve(outputArg)
fs.mkdirSync(output)
const manifest=JSON.parse(fs.readFileSync(path.join(mediaArg,'manifest.json')))
assert.equal(manifest.cases.length,4)
for (const fixture of manifest.cases) assert.equal(createHash('sha256').update(fs.readFileSync(fixture.file)).digest('hex'),fixture.sha256,'Fixture hash mismatch')
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-playback-acceptance-colors-'))
const targets=seedAcceptanceCatalog(profile,manifest.cases.map(c=>c.file))
fs.writeFileSync(path.join(profile,'this-computer.json'),JSON.stringify({mode:'local',closeToTray:false,linuxPlaybackMode:mode,resumePlayback:false,playbackVolume:0}))
const nativeSize=nativeViewportProbe()
const port=Number(process.env.JAVDEX_ACCEPTANCE_PORT||9577)
try {await fetch(`http://127.0.0.1:${port}/json/version`);throw new Error('Port occupied')}catch(e){if(e.message==='Port occupied')throw e}
const report={image,sha256:createHash('sha256').update(fs.readFileSync(image)).digest('hex'),display,mode,nativeViewport:nativeSize,cases:[]}
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
const env={...process.env,JAVDEX_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE
const log=fs.openSync(path.join(output,'application.log'),'w')
const child=spawn(image,[`--javdex-${display}`,`--remote-debugging-port=${port}`,...(nativeSize?[`--inspect=127.0.0.1:${port+1}`]:[])],{env,stdio:['ignore',log,log]})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let browser
try {
 for(let i=0;i<150;i++){assert.equal(child.exitCode,null);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}await sleep(200)}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
 const page=browser.contexts()[0].pages()[0]
 await page.waitForFunction(()=>window.api?.player&&document.querySelector('nav'))
 await installNativeViewportProbe(port+1,nativeSize)
 const cdp=await browser.newBrowserCDPSession();report.gpu=await cdp.send('SystemInfo.getInfo')

 for(let i=0;i<manifest.cases.length;i++) {
  const fixture=manifest.cases[i],entry={fixture};report.cases.push(entry);save()
  await page.evaluate(t=>{document.title=t},`Javdex 色彩验收 ${display} / ${mode} / ${fixture.name}`)
  assert.equal((await page.evaluate(t=>window.api.player.play(t.libraryId,t.videoId),targets[i])).ok,true)
  let state;const deadline=Date.now()+20000
  for(;;){state=await page.evaluate(()=>window.api.playback.snapshot());if(state?.phase==='playing'&&state.position>2&&state.info.playbackMode===mode)break;assert(Date.now()<deadline,JSON.stringify(state));await sleep(150)}
  entry.state=state
  if(nativeSize)assert.deepEqual(await page.evaluate(()=>{const c=document.querySelector('canvas[data-playback-surface]');return {width:c.width,height:c.height}}),nativeSize)
  // Capture compositor image first; Canvas readback can change later rendering.
  const canvas=page.locator('canvas[data-playback-surface]')
  const box=await canvas.boundingBox();assert(box)
  const geometry=await canvas.evaluate(c=>({width:c.width,height:c.height,fit:getComputedStyle(c).objectFit}))
  assert(['contain','fill'].includes(geometry.fit),'Unsupported Canvas object-fit')
  const factor=Math.min(box.width/geometry.width,box.height/geometry.height)
  const content=geometry.fit==='contain'?{width:geometry.width*factor,height:geometry.height*factor}:box
  const origin={x:box.x+(box.width-content.width)/2,y:box.y+(box.height-content.height)/2}
  entry.geometry={box,geometry,content,origin}
  const png=await page.screenshot({path:path.join(output,fixture.name+'.png')})
  const {data,info}=await sharp(png).removeAlpha().raw().toBuffer({resolveWithObject:true})
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
  entry.screen=[]
  for(let patch=0;patch<8;patch++){
   const u=(Math.floor(geometry.width*(patch+.5)/8)+.5)/geometry.width,v=(Math.floor(geometry.height/4)+.5)/geometry.height
   const x=Math.round((origin.x+content.width*u)*info.width/viewport.width),y=Math.round((origin.y+content.height*v)*info.height/viewport.height)
   entry.screen.push([...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)])
  }
  entry.canvas=await page.evaluate(()=>{const c=document.querySelector('canvas[data-playback-surface]'),ctx=c.getContext('2d');return Array.from({length:8},(_,i)=>[...ctx.getImageData(Math.floor(c.width*(i+.5)/8),Math.floor(c.height/4),1,1).data])})
  entry.colors=await page.evaluate(()=>{const c=document.querySelector('canvas[data-playback-surface]'),ctx=c.getContext('2d');return Array.from({length:8},(_,i)=>[...ctx.getImageData(Math.floor(c.width*(i+.5)/8),Math.floor(c.height*.75),1,1).data])})
  if(fixture.levels){entry.expected=fixture.levels.map(v=>Math.round(v*255));entry.maxError=Math.max(...entry.canvas.flatMap((p,i)=>p.slice(0,3).map(v=>Math.abs(v-entry.expected[i]))))}
  assert(entry.canvas.every(p=>p[3]===255),'Non-opaque output')
  assert(Math.max(...entry.canvas.flatMap((p,i)=>p.slice(0,3).map((v,c)=>Math.abs(v-entry.screen[i][c]))))<=4,'Canvas and compositor samples disagree')
  if(fixture.levels){
   assert(entry.maxError<=3,'SDR range/gray error: '+entry.maxError)
   if(fixture.colors){
    entry.colorError=Math.max(...entry.colors.flatMap((p,i)=>p.slice(0,3).map((v,c)=>Math.abs(v-Math.round(fixture.colors[i][c]*255)))))
    assert(entry.colorError<=3,'SDR primary color conversion error: '+entry.colorError)
   }
  }else{
   assert(entry.canvas[0][0]<=3&&entry.canvas[7][0]>=230,'HDR black/peak not mapped to SDR')
   for(let n=1;n<8;n++)assert(entry.canvas[n][0]>entry.canvas[n-1][0],'HDR gray steps collapsed')
   for(let n=0;n<3;n++)assert(entry.colors[n][n]>70&&entry.colors[n][n]>Math.max(...entry.colors[n].slice(0,3).filter((_,c)=>c!==n))+50,'HDR primary hue lost')
  }
  entry.status='passed-automated';save()
  await page.evaluate(id=>window.api.playback.control(id,{kind:'stop'}),state.sessionId)
  for(let n=0;n<100;n++){if(await page.evaluate(()=>window.api.playback.snapshot())===null)break;await sleep(100)}
 }
 report.status='passed-automated'
}catch(e){report.status='failed';report.error=String(e);process.exitCode=1}
finally{save();await browser?.contexts()[0]?.pages()[0]?.evaluate(()=>window.close()).catch(()=>{});await browser?.close();child.kill('SIGTERM');fs.closeSync(log)}
