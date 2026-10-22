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
assert(imageArg && mediaArg && outputArg, 'Usage: node scripts/linux-codec-acceptance.mjs APPIMAGE MEDIA_DIR NEW_OUTPUT_DIR [wayland|x11] [gpu|cpu|auto]')
assert(['wayland', 'x11'].includes(display) && ['gpu', 'cpu', 'auto'].includes(mode))
const codecLimit = Number(process.env.JAVDEX_CODEC_LIMIT || 3)
const firstDuration = Number(process.env.JAVDEX_CODEC_SECONDS || 65)
assert(Number.isInteger(codecLimit) && codecLimit >= 1 && codecLimit <= 3, 'Codec limit must be an integer from 1 to 3')
assert(Number.isInteger(firstDuration) && firstDuration >= 3, 'Playback duration must be an integer of at least 3 seconds')
const image = path.resolve(imageArg), media = path.resolve(mediaArg), output = path.resolve(outputArg)
fs.mkdirSync(output) // Refuse to overwrite an earlier run.
const files = ['h264-1080p30.mp4', 'hevc-main10-1080p30.mkv', 'av1-1080p30.mkv'].slice(0, codecLimit).map(f => path.join(media, f))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-acceptance-codecs-'))
const targets = seedAcceptanceCatalog(profile, files)
fs.writeFileSync(path.join(profile, 'this-computer.json'), JSON.stringify({mode:'local', closeToTray:false, linuxPlaybackMode:mode, resumePlayback:false, playbackVolume:25}))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const report = { image, sha256:hash(image), display, mode, profile, media:files.map(file=>({file,sha256:hash(file)})), cases:[], pending:['human audio sync', 'other GPUs and desktops', 'HDR and 4K60'] }
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2))
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms))
const port = Number(process.env.JAVDEX_ACCEPTANCE_PORT || 9563)
const probeFault = process.env.JAVDEX_ACCEPTANCE_PROBE_FAULT
assert(!probeFault || ['black', 'timeout'].includes(probeFault))
const checkControls = process.env.JAVDEX_CODEC_CONTROLS === '1'
const runtimeFault = process.env.JAVDEX_ACCEPTANCE_RUNTIME_FAILURE === '1'
assert(!runtimeFault || checkControls && mode === 'auto')
const expectedMode = mode === 'cpu' || probeFault ? 'cpu' : 'gpu'
const forcedDecoder = process.env.JAVDEX_ACCEPTANCE_HWDEC
assert(!forcedDecoder || ['vaapi-copy', 'nvdec-copy', 'no'].includes(forcedDecoder))
const expectedDecoder = process.env.JAVDEX_EXPECT_HWDEC
report.forcedDecoder = forcedDecoder ?? null
report.expectedDecoder = expectedDecoder ?? null
try { await fetch(`http://127.0.0.1:${port}/json/version`); throw new Error('Debugging port already occupied') } catch(e) { if (e.message==='Debugging port already occupied') throw e }
const log = fs.openSync(path.join(output,'application.log'),'w')
const env = {...process.env,JAVDEX_TEST_USER_DATA:profile}; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(image,[`--javdex-${display}`,`--remote-debugging-port=${port}`, ...(forcedDecoder || checkControls || probeFault ? [`--inspect=127.0.0.1:${port+1}`] : [])],{env,stdio:['ignore',log,log]})
let browser
try {
  for(let i=0;i<150;i++) { try { if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break } catch {} await sleep(200) }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts()[0].pages()[0]
  await page.waitForFunction(()=>window.api?.player && document.querySelector('nav'))
  await page.evaluate(label=>{document.title=label}, `Javdex 硬解验收 ${expectedDecoder || mode} / ${display}`)
  const cdp = await browser.newBrowserCDPSession()
  report.chromiumGPU = await cdp.send('SystemInfo.getInfo')
  // snapshot is async IPC: await its value before deciding whether to poll again.
  // A Promise object itself must never satisfy the readiness predicate.
  async function waitState(predicate, timeout = 20000) {
    const deadline = Date.now() + timeout
    for (;;) {
      const state = await page.evaluate(() => window.api.playback.snapshot())
      if (predicate(state)) return state
      assert(Date.now() < deadline, 'Playback state did not settle: ' + JSON.stringify(state))
      await sleep(100)
    }
  }
  async function mainEvaluate(expression) {
    const targets = await (await fetch(`http://127.0.0.1:${port+1}/json/list`)).json()
    const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
    try {
      const response = await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Main inspector timed out')),10000)
        socket.addEventListener('message',event=>{clearTimeout(timeout);resolve(JSON.parse(event.data))},{once:true})
        socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}))
      })
      assert(!response.result?.exceptionDetails,JSON.stringify(response))
      return response.result.result.value
    } finally { socket.close() }
  }
  if (checkControls || probeFault) {
    // Intercept emission, preserving listener identity and normal cleanup.
    await mainEvaluate(`(()=>{const ipc=process.getBuiltinModule('module').createRequire(process.execPath)('electron').ipcMain,original=ipc.emit;ipc.emit=function(name,event,data,...rest){if(name==='playback:shared-texture-self-test'){console.info('[acceptance-probe-samples]',JSON.stringify(data.samples));${probeFault === 'timeout' ? 'return true;' : probeFault === 'black' ? 'data={...data,samples:Array(20).fill(0)};' : ''}}return original.call(this,name,event,data,...rest)};return true})()`)
    if (probeFault) report.injectedProbeFault=probeFault
  }
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
      await waitState(s=>s?.target.videoId===targets[index].videoId&&s.phase==='playing'&&s.position>0.5&&s.info.playbackMode===expectedMode)
      const duration = index===0 ? firstDuration : 8
      for(let second=0;second<duration;second++) {
        await sleep(1000)
        const state=await page.evaluate(()=>window.api.playback.snapshot())
        assert.equal(state?.phase,'playing',JSON.stringify(state)); assert.equal(state.info.playbackMode,expectedMode)
        assert.equal(state.info.playbackFallback,Boolean(probeFault))
        if (probeFault) assert.equal(state.info.playbackDiagnostics.fallbackReason,probeFault === 'black' ? 'DISPLAY_SELF_TEST_FAILED' : 'DISPLAY_SELF_TEST_TIMEOUT')
        if (expectedMode === 'gpu') assert.equal(state.info.playbackDiagnostics.displayProbe, 'passed')
        if(expectedDecoder) assert.equal(state.info.hardwareDecoder,expectedDecoder)
        assert.match(state.info.videoCodec, [/H\.264/, /HEVC|H\.265/, /AV1/][index])
        assert.equal(state.info.width,1920); assert.equal(state.info.height,1080)
        test.samples.push(state)
        if(second===2 || second===duration-1) await page.screenshot({path:path.join(output,`codec-${index}-${second}.png`)})
      }
      assert(test.samples.at(-1).position>test.samples[0].position+duration-2,'Playback clock did not advance')
      // Readback is deliberately after the timing run; screenshots are reviewed separately.
      test.pixels=await page.evaluate(()=>{const c=document.querySelector('canvas[data-playback-surface]');if(!c)return null;const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let colored=0;for(let i=0;i<a.length;i+=4)if(Math.max(a[i],a[i+1],a[i+2])-Math.min(a[i],a[i+1],a[i+2])>50)colored++;return {width:c.width,height:c.height,colored}})
      if (process.env.JAVDEX_EXPECT_BLACK === '1') assert.equal(test.pixels?.colored,0,'Black fixture changed color')
      else assert(test.pixels?.colored>10000,'Synthetic colored frame missing')
      if (checkControls) {
        const snapshot = () => page.evaluate(()=>window.api.playback.snapshot())
        const session = (await snapshot()).sessionId
        const control = command => page.evaluate(({session,command})=>window.api.playback.control(session,command),{session,command})
        const waitPosition = async seconds => {
          const deadline=Date.now()+10000
          for (;;) {
            const s=await snapshot()
            assert.equal(s.phase,'paused'); assert.equal(s.paused,true); assert.equal(s.info.hardwareDecoder,expectedDecoder)
            if(!s.seeking && Math.abs(s.position-seconds)<0.5) return s
            assert(Date.now()<deadline, 'Seek did not settle: '+JSON.stringify(s)); await sleep(100)
          }
        }
        await control({kind:'pause',paused:true}); await sleep(350)
        const before=await snapshot(); await sleep(700); const after=await snapshot()
        assert.equal(after.paused,true); assert(Math.abs(before.position-after.position)<0.15)
        test.controls={pause:true,seeks:[]}
        await control({kind:'volume',value:37}); await control({kind:'speed',value:1.25})
        for(const seconds of [2,6,1]) {
          await control({kind:'seek',seconds}); test.controls.seeks.push(await waitPosition(seconds))
        }
        const subtitle=files[index].replace(/\.[^.]+$/,'.srt'); assert(fs.existsSync(subtitle))
        await mainEvaluate(`process.getBuiltinModule('module').createRequire(process.execPath)('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(subtitle)}]})`)
        await page.evaluate(id=>window.api.playback.subtitle(id),session); await sleep(400)
        assert((await snapshot()).tracks.some(t=>t.type==='sub'&&t.selected))
        await page.screenshot({path:path.join(output,`codec-${index}-paused-subtitle.png`)})
        if (runtimeFault) {
          await mainEvaluate(`(()=>{process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.emit('child-process-gone',{}, {type:'GPU'});return true})()`)
          await waitState(s=>s?.info.playbackMode==='cpu'&&s.paused&&Math.abs(s.position-1)<0.5&&s.tracks.some(t=>t.type==='sub'&&t.selected),15000)
          await sleep(500);const recovered=await snapshot()
          assert.equal(recovered.info.playbackDiagnostics.fallbackReason,'GPU_PROCESS_EXITED')
          assert.equal(recovered.volume,37);assert.equal(recovered.speed,1.25);assert.equal(recovered.paused,true)
          test.controls.cpuRecovery=recovered
          await page.screenshot({path:path.join(output,`codec-${index}-cpu-recovery.png`)})
        }
        await control({kind:'pause',paused:false}); await sleep(1800)
        assert((await snapshot()).position>2); test.controls.resume=true
        for(const [width,height] of [[1100,750],[1600,1000]]) {
          await mainEvaluate(`(()=>{const w=process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows()[0];w.unmaximize();w.setBounds({width:${width},height:${height}});return true})()`)
          await sleep(700); await page.screenshot({path:path.join(output,`codec-${index}-resize-${width}.png`)})
        }
        await control({kind:'stop'})
        await waitState(s=>s===null)
        assert.equal((await page.evaluate(t=>window.api.player.play(t.libraryId,t.videoId),targets[index])).ok,true)
        await waitState(s=>s&&s.sessionId!==session&&s.phase==='playing'&&s.position>0.5&&s.info.hardwareDecoder===expectedDecoder)
        await sleep(700);const reopened=await snapshot()
        assert.equal(reopened.info.hardwareDecoder,expectedDecoder,JSON.stringify(reopened));assert.equal(reopened.info.playbackFallback,false)
        test.controls.reopen=reopened
        await page.screenshot({path:path.join(output,`codec-${index}-reopen.png`)})
      }
      test.status='passed-automated'; test.visualReview='pending';
    } catch(e) {test.status='failed';test.error=String(e);test.failureSnapshot=await page.evaluate(()=>window.api.playback.snapshot()).catch(()=>null);await page.screenshot({path:path.join(output,`codec-${index}-failure.png`)}).catch(()=>{})}
    if (index === 0 && process.env.JAVDEX_ACCEPTANCE_UI_INFO === '1') {
      await page.getByRole('button',{name:'播放设置',exact:true}).click({force:true})
      await page.getByRole('tab',{name:'信息',exact:true}).click()
      await page.screenshot({path:path.join(output,'playback-info.png')})
      test.infoPanelText=await page.getByRole('tabpanel',{name:'信息'}).innerText()
      await page.getByRole('button',{name:'关闭播放设置',exact:true}).click()
    }
    const state=await page.evaluate(()=>window.api.playback.snapshot())
    if(state) { await page.evaluate(id=>window.api.playback.control(id,{kind:'stop'}),state.sessionId); await waitState(s=>s===null) }
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
