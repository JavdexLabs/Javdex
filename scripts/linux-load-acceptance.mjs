import { nativeViewportProbe, installNativeViewportProbe } from './linux-native-viewport-probe.mjs'
// Measures one final-package playback at a time. Never benchmark while building.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chromium} from 'playwright-core'
import {seedAcceptanceCatalog} from './playback-acceptance-support.mjs'
const [imageArg,mediaArg,outputArg,display,mode,durationArg='65']=process.argv.slice(2)
assert(imageArg&&mediaArg&&outputArg&&['wayland','x11'].includes(display)&&['gpu','cpu','auto'].includes(mode),'Usage: node scripts/linux-load-acceptance.mjs APPIMAGE MEDIA NEW_OUTPUT wayland|x11 gpu|cpu|auto [SECONDS]')
const duration=Number(durationArg);assert(Number.isInteger(duration)&&duration>=60&&duration<=660)
const isolation=process.env.JAVDEX_ACCEPTANCE_ENV;assert(!isolation||['missing-vaapi','no-gpu'].includes(isolation))
const expected=isolation?'cpu':mode==='auto'?'gpu':mode
const image=path.resolve(imageArg),media=path.resolve(mediaArg),output=path.resolve(outputArg)
fs.mkdirSync(output)
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-playback-acceptance-load-'))
const target=seedAcceptanceCatalog(profile,[media])[0]
fs.writeFileSync(path.join(profile,'this-computer.json'),JSON.stringify({mode:'local',closeToTray:false,linuxPlaybackMode:mode,resumePlayback:false,playbackVolume:15}))
async function hash(file){const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex')}
const report={image,sha256:await hash(image),media,mediaSha256:await hash(media),display,mode,duration,isolation,samples:[]}
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const nativeSize=nativeViewportProbe();report.nativeViewport=nativeSize
const port=Number(process.env.JAVDEX_ACCEPTANCE_PORT||9577)
try{await fetch(`http://127.0.0.1:${port}/json/version`);throw new Error('Port occupied')}catch(e){if(e.message==='Port occupied')throw e}
const log=fs.openSync(path.join(output,'application.log'),'w'),env={...process.env,JAVDEX_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE
let executable=image,args=[`--javdex-${display}`,`--remote-debugging-port=${port}`,...(nativeSize?[`--inspect=127.0.0.1:${port+1}`]:[])]
if(isolation){
 const emptyLibrary=path.join(profile,'unavailable-library');fs.writeFileSync(emptyLibrary,'')
 const restrictions=isolation==='missing-vaapi'?['--dev-bind','/dev','/dev','--ro-bind',emptyLibrary,fs.realpathSync('/usr/lib/x86_64-linux-gnu/libva.so.2')]:['--dev','/dev']
 args=['--bind','/','/',...restrictions,'--',image,...args];executable='/usr/bin/bwrap'
}
const child=spawn(executable,args,{env,stdio:['ignore',log,log]});report.pid=child.pid;let browser
function processes(rootPid){
 const all=[]
 for(const name of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)))try{
  const text=fs.readFileSync(`/proc/${name}/stat`,'utf8'),tail=text.slice(text.lastIndexOf(')')+2).split(' ')
  const status=fs.readFileSync(`/proc/${name}/status`,'utf8')
  const processName=text.slice(text.indexOf('(')+1,text.lastIndexOf(')'))
  let memory
  if(processName.startsWith('playback-')) {
   try { const rollup=fs.readFileSync(`/proc/${name}/smaps_rollup`,'utf8');memory=Object.fromEntries(['Rss','Pss','Anonymous','Private_Clean','Private_Dirty','Shared_Clean','Shared_Dirty','Swap'].map(key=>[key+'KiB',Number(rollup.match(new RegExp('^'+key+':\\s+(\\d+)','m'))?.[1]||0)])) }
   catch {} // Some kernels restrict smaps; absence is not a zero-memory result.
  }
  all.push({pid:Number(name),parent:Number(tail[1]),ticks:Number(tail[11])+Number(tail[12]),rssKiB:Number(status.match(/VmRSS:\s+(\d+)/)?.[1]||0),name:processName,fds:fs.readdirSync(`/proc/${name}/fd`).length,...(memory?{memory}: {})})
 }catch{}
 const descendants=new Set([rootPid]);let changed=true
 while(changed){changed=false;for(const p of all)if(descendants.has(p.parent)&&!descendants.has(p.pid)){descendants.add(p.pid);changed=true}}
 return all.filter(p=>descendants.has(p.pid))
}
try{
 for(let i=0;i<150;i++){assert.equal(child.exitCode,null,'App exited');try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}await sleep(200)}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const page=browser.contexts()[0].pages()[0]
 await page.waitForFunction(()=>window.api?.player&&document.querySelector('nav'))
 await installNativeViewportProbe(port+1,nativeSize)
 await page.evaluate(t=>{document.title=t},`Javdex 4K/长测 ${display} / ${mode} ${isolation||''}`)
 const cdp=await browser.newBrowserCDPSession();report.gpu=await cdp.send('SystemInfo.getInfo')
 assert.equal((await page.evaluate(t=>window.api.player.play(t.libraryId,t.videoId),target)).ok,true)
 let state;const deadline=Date.now()+30000
 for(;;){state=await page.evaluate(()=>window.api.playback.snapshot());if(state?.phase==='playing'&&state.position>1&&state.info.playbackMode===expected)break;assert(Date.now()<deadline,JSON.stringify(state));await sleep(200)}
 report.viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio}))
 report.start=state;const started=performance.now()
 for(let i=0;i<duration;i++){
  await sleep(Math.max(0,started+(i+1)*1000-performance.now()))
  const snapshot=await page.evaluate(()=>window.api.playback.snapshot())
  assert.equal(snapshot?.phase,'playing',JSON.stringify(snapshot));assert.equal(snapshot.info.playbackMode,expected)
  if(expected==='cpu')assert.equal(snapshot.info.hardwareDecoder,'no')
  if(isolation==='missing-vaapi')assert.equal(snapshot.info.playbackFallback,true)
  report.samples.push({elapsedMs:performance.now()-started,snapshot,processes:processes(child.pid)});save()
 }
 report.end=report.samples.at(-1).snapshot
 assert(report.end.position>report.start.position+duration-3,'Playback did not keep real time')
 report.droppedFrames=report.end.info.droppedFrames-report.start.info.droppedFrames
 // No readback during the timed run; inspect and sample only afterwards.
 try { await page.screenshot({path:path.join(output,'end.png'),timeout:5000}) } catch(error) { report.screenshotError=String(error) }
 report.pixels=await page.evaluate(()=>{const c=document.querySelector('canvas[data-playback-surface]'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let colored=0;for(let i=0;i<d.length;i+=64)if(Math.max(d[i],d[i+1],d[i+2])-Math.min(d[i],d[i+1],d[i+2])>50)colored++;return {width:c.width,height:c.height,colored}})
 if(nativeSize)assert.deepEqual({width:report.pixels.width,height:report.pixels.height},nativeSize)
 assert(report.pixels.colored>Math.min(1000,report.pixels.width*report.pixels.height/64),'No visible synthetic colors')
 report.status=report.screenshotError?'needs-screen-confirmation':'measured'
}catch(e){report.status='failed';report.error=String(e);process.exitCode=1}
finally{save();if(process.env.JAVDEX_ACCEPTANCE_KEEP_OPEN==='1'){fs.writeFileSync(path.join(output,'window.json'),JSON.stringify({pid:child.pid,port,profile}));console.log('Window retained for visual confirmation');while(child.exitCode===null)await sleep(1000)}await browser?.contexts()[0]?.pages()[0]?.evaluate(()=>window.close()).catch(()=>{});await browser?.close();child.kill('SIGTERM');fs.closeSync(log)}
