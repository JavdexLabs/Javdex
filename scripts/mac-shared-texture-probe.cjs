// Vertical native->Chromium->Canvas probe, not full Javdex GUI acceptance.
const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const [addon, output, preload] = process.argv.slice(2)
assert.equal(process.platform, 'darwin')
for (const value of [addon, output, preload]) assert.ok(value && path.isAbsolute(value))
assert.ok(!fs.existsSync(output), 'probe requires a new evidence directory')
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'))
const native = require(addon)
const token = '11111111-1111-4111-8111-111111111111'
let window, timer, pending = new Set(), complete = false
const finish = async error => {
  if (complete) return
  complete = true; clearTimeout(timer)
  native.destroy()
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: !error, error: error?.stack,
    verticalProbeOnly: true, physicalPresentation: 'not-certified', pending: [...pending], native: native.inspect() }, null, 2))
  setTimeout(() => app.exit(error ? 1 : 0), 100)
}
app.whenReady().then(async () => {
  native.create({ width: 640, height: 360, scale: 1 }); native.setVisible(true)
  window = new BrowserWindow({ title: 'Javdex IOSurface vertical probe', width: 680, height: 420, show: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  window.webContents.on('console-message', event => console.log('[renderer]', event.message))
  window.webContents.on('preload-error', (_event, _file, error) => { void finish(error) })
  const trusted = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  ipcMain.on('playback:frame-clock', (event, value) => {
    if (trusted(event)) window.webContents.send('playback:frame-clock', { ...value, mainTime: Number(process.hrtime.bigint()) / 1e6 })
  })
  ipcMain.once('playback:shared-texture-ready', (event, binding) => {
    if (!trusted(event)) return
    // send readiness precedes receiver mounting; defer one task before transfer.
    setTimeout(async () => {
      let imported
      try {
        const frame = native.nextFrame(true); assert.ok(frame)
        pending.add(frame.sequence)
        imported = sharedTexture.importSharedTexture({ textureInfo: { pixelFormat: 'bgra', codedSize: { width: frame.width, height: frame.height }, handle: { ioSurface: frame.ioSurface } },
          allReferencesReleased: () => { native.releaseFrame(frame.sequence); pending.delete(frame.sequence) } })
        await sharedTexture.sendSharedTexture({ frame: window.webContents.mainFrame, importedSharedTexture: imported }, { ...binding, sequence: frame.sequence, timeline: 0, targetTime: 0 })
      } catch (error) { await finish(error) }
      finally { imported?.release() }
    }, 50)
  })
  ipcMain.once('playback:shared-texture-failed', () => { void finish(new Error('Canvas receiver failed')) })
  ipcMain.once('playback:shared-texture-submitted', async event => {
    if (!trusted(event)) return
    try {
      await new Promise(resolve => setTimeout(resolve, 250))
      // Capture the entire Chromium window before any Canvas/media readback.
      const image = await window.webContents.capturePage()
      fs.writeFileSync(path.join(output, 'window.png'), image.toPNG())
      const pixels = image.toBitmap(), { width, height } = image.getSize()
      const samples = [[100, 100], [300, 200], [600, 300]].map(([x, y]) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)])
      assert.ok(samples.every(([b,g,r,a]) => Math.abs(b - 128) < 10 && Math.abs(g - 191) < 10 && Math.abs(r - 64) < 10 && a === 255), JSON.stringify(samples))
      fs.writeFileSync(path.join(output, 'capture.json'), JSON.stringify({ width, height, samples, gpu: await app.getGPUInfo('complete') }, null, 2))
      await finish()
    } catch (error) { await finish(error) }
  })
  timer = setTimeout(() => { void finish(new Error('IOSurface window probe timed out')) }, 15000)
  const html = path.join(output, 'index.html')
  fs.writeFileSync(html, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>body{margin:0;background:black}canvas{width:640px;height:360px}</style><canvas data-playback-surface="${token}"></canvas><script>window.textureProbe.bind('${token}')</script>`)
  await window.loadFile(html)
}).catch(error => { void finish(error) })
