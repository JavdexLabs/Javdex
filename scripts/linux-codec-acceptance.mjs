// Final AppImage test: synthetic media only, isolated catalog, no user settings.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { seedAcceptanceCatalog } from './playback-acceptance-support.mjs'

const [imageArg, mediaArg, outputArg, display = 'wayland', mode = 'gpu'] = process.argv.slice(2)
assert(imageArg && mediaArg && outputArg, 'Usage: node scripts/linux-codec-acceptance.mjs APPIMAGE MEDIA_DIR NEW_OUTPUT_DIR [wayland|x11] [gpu|cpu]')
assert(['wayland', 'x11'].includes(display) && ['gpu', 'cpu'].includes(mode))
const image = path.resolve(imageArg), media = path.resolve(mediaArg), output = path.resolve(outputArg)
fs.mkdirSync(output) // Refuse to overwrite an earlier run.
const files = ['h264-1080p30.mp4', 'hevc-main10-1080p30.mkv', 'av1-1080p30.mkv'].map(f => path.join(media, f))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-acceptance-codecs-'))
const targets = seedAcceptanceCatalog(profile, files)
fs.writeFileSync(path.join(profile, 'this-computer.json'), JSON.stringify({mode:'local', closeToTray:false, linuxPlaybackMode:mode, resumePlayback:false, playbackVolume:25}))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const report = { image, sha256:hash(image), display, mode, profile, media:files.map(file=>({file,sha256:hash(file)})), cases:[], pending:['human audio sync', 'other GPUs and desktops', 'HDR and 4K60'] }
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2))
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms))
const port = Number(process.env.JAVDEX_ACCEPTANCE_PORT || 9563)
const forcedDecoder = process.env.JAVDEX_ACCEPTANCE_HWDEC
assert(!forcedDecoder || ['vaapi-copy', 'nvdec-copy', 'no'].includes(forcedDecoder))
const expectedDecoder = process.env.JAVDEX_EXPECT_HWDEC
report.forcedDecoder = forcedDecoder ?? null
report.expectedDecoder = expectedDecoder ?? null
try { await fetch(`http://127.0.0.1:${port}/json/version`); throw new Error('Debugging port already occupied') } catch(e) { if (e.message==='Debugging port already occupied') throw e }
const log = fs.openSync(path.join(output,'application.log'),'w')
const env = {...process.env,JAVDEX_TEST_USER_DATA:profile}; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(image,[`--javdex-${display}`,`--remote-debugging-port=${port}`, ...(forcedDecoder ? [`--inspect=127.0.0.1:${port+1}`] : [])],{env,stdio:['ignore',log,log]})
let browser
try {
  for(let i=0;i<150;i++) { try { if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break } catch {} await sleep(200) }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts()[0].pages()[0]
  await page.waitForFunction(()=>window.api?.player && document.querySelector('nav'))
  await page.evaluate(label=>{document.title=label}, `Javdex 硬解验收 ${expectedDecoder || mode} / ${display}`)
  const cdp = await browser.newBrowserCDPSession()
  report.chromiumGPU = await cdp.send('SystemInfo.getInfo')
  if (forcedDecoder) {
    // Test-only main-process hook: select a decoder before each load without
    // adding an arbitrary-command API or changing the application's defaults.
    const targets = await (await fetch(`http://127.0.0.1:${port+1}/json/list`)).json()
    const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
    const expression = `(()=>{
      const cp=process.getBuiltinModule('child_process'),original=cp.spawn;
      const encode=fields=>{const values=fields.map(v=>Buffer.from(v)),b=Buffer.alloc(8+values.reduce((n,v)=>n+4+v.length,0));b.writeUInt32LE(b.length-4);b.writeUInt32LE(values.length,4);let p=8;for(const v of values){b.writeUInt32LE(v.length,p);p+=4;v.copy(b,p);p+=v.length}return b};
      cp.spawn=function(...args){const child=original.apply(this,args);if(String(args[0]).endsWith('playback-dmabuf-helper')){const write=child.stdin.write.bind(child.stdin);child.stdin.write=function(b,...rest){let p=8,fields=[];for(let i=0;i<b.readUInt32LE(4);i++){const n=b.readUInt32LE(p);p+=4;fields.push(b.toString('utf8',p,p+n));p+=n}if(fields[0]==='command'&&fields[1]==='loadfile'){write(encode(['command','set','hwdec',${JSON.stringify(forcedDecoder)}]));${forcedDecoder==='vaapi-copy' ? "write(encode(['command','set','vaapi-device','/dev/dri/renderD128']));" : ''}}return write(b,...rest)}}return child};return true
    })()`
    const response=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Inspector decoder hook timed out')),10000);socket.addEventListener('message',event=>{clearTimeout(timeout);resolve(JSON.parse(event.data))},{once:true});socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}))})
    socket.close(); assert(!response.result?.exceptionDetails,JSON.stringify(response))
  }

  for(let index=0;index<targets.length;index++) {
    const test = {file:files[index],status:'running',samples:[]}; report.cases.push(test); save()
    try {
      const opened = await page.evaluate(t=>window.api.player.play(t.libraryId,t.videoId),targets[index])
      assert.equal(opened.ok,true,JSON.stringify(opened))
      await page.waitForFunction(()=>window.api.playback.snapshot().then(s=>s?.phase==='playing'&&s.position>0.5),null,{timeout:20000})
      const duration = index===0 ? Number(process.env.JAVDEX_CODEC_SECONDS || 65) : 8
      for(let second=0;second<duration;second++) {
        await sleep(1000)
        const state=await page.evaluate(()=>window.api.playback.snapshot())
        assert.equal(state?.phase,'playing',JSON.stringify(state)); assert.equal(state.info.playbackMode,mode)
        assert.equal(state.info.playbackFallback,false)
        if(expectedDecoder) assert.equal(state.info.hardwareDecoder,expectedDecoder)
        assert.match(state.info.videoCodec, [/H\.264/, /HEVC|H\.265/, /AV1/][index])
        assert.equal(state.info.width,1920); assert.equal(state.info.height,1080)
        test.samples.push(state)
        if(second===2 || second===duration-1) await page.screenshot({path:path.join(output,`codec-${index}-${second}.png`)})
      }
      assert(test.samples.at(-1).position>test.samples[0].position+duration-2,'Playback clock did not advance')
      // Readback is deliberately after the timing run; screenshots are reviewed separately.
      test.pixels=await page.evaluate(()=>{const c=document.querySelector('canvas[data-playback-surface]');if(!c)return null;const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let colored=0;for(let i=0;i<a.length;i+=4)if(Math.max(a[i],a[i+1],a[i+2])-Math.min(a[i],a[i+1],a[i+2])>50)colored++;return {width:c.width,height:c.height,colored}})
      assert(test.pixels?.colored>10000,'Synthetic colored frame missing')
      test.status='passed-automated'; test.visualReview='pending';
    } catch(e) {test.status='failed';test.error=String(e)}
    const state=await page.evaluate(()=>window.api.playback.snapshot())
    if(state) await page.evaluate(id=>window.api.playback.control(id,{kind:'stop'}),state.sessionId)
    save()
  }
  report.status=report.cases.every(c=>c.status==='passed-automated')?'passed-automated':'failed'
  if(report.status==='failed') process.exitCode=1
} catch(e) {report.status='failed';report.error=String(e);process.exitCode=1}
finally {
  save()
  if(browser) {await browser.contexts()[0].pages()[0]?.evaluate(()=>window.close()).catch(()=>{});await browser.close()}
  if(child.exitCode===null) child.kill()
  fs.closeSync(log)
}
