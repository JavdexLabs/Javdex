// Isolated real-Electron acceptance entry; no personal library or visible window.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = process.env.JAVDEX_STARTUP_ACCEPTANCE_ROOT
if (!root) throw Error('Missing acceptance root')
const output = path.join(root, 'events.jsonl')
const write = value => fs.appendFileSync(output, JSON.stringify({ pid: process.pid, ...value }) + '\n')
const entries = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(v => v.event === 'entry').length : 0
const scenario = process.env.JAVDEX_STARTUP_ACCEPTANCE_SCENARIO
app.setName('Javdex Startup Acceptance')
app.setPath('userData', path.join(root, 'profile'))
const code = fs.readFileSync(path.join(root, 'startupGraphics.js'), 'utf8')
const exportsAdapter = {}
vm.runInNewContext(code, { exports: exportsAdapter, process, Date,
  require(id) {
    if (id === './startupGraphicsRecovery') return require(path.join(root, 'startupGraphicsRecovery.js'))
    if (id === 'electron') return { app, shell: { openPath: async () => '' }, dialog: {
      showErrorBox(title, message) { write({ event: 'error-dialog', title, message }) },
      showMessageBox(options) { write({ event: 'recovered-dialog', options }); return Promise.resolve({ response: scenario === 'user-retry' && entries === 1 ? 1 : 0 }) }
    } }
    return require(id)
  }
}, { filename: 'startupGraphics.js' })
const { configureStartupGraphics, startupGraphics } = exportsAdapter
configureStartupGraphics()
startupGraphics.claimPrimary(app.requestSingleInstanceLock())
write({ event: 'entry', args: process.argv.slice(1) })
app.on('quit', () => write({ event: 'quit' }))
if (scenario === 'pre-ready' && entries === 0) {
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 16 })
}
const deadline = setTimeout(() => { write({ event: 'timeout' }); app.exit(2) }, 15000)
deadline.unref()
app.whenReady().then(async () => {
  if (!startupGraphics.canContinue()) return
  write({ event: 'electron-ready', accelerated: app.isHardwareAccelerationEnabled() })
  if (scenario === 'non-graphics') { startupGraphics.startupFailed(new Error('Synthetic database initialization failure')); return }
  const shouldFail = scenario !== 'normal' && scenario !== 'manual-software'
    && (entries === 0 || scenario === 'double-failure' && entries === 1)
  if (shouldFail) {
    // Inject only the GPU event; relaunch, process exit, profile/lock, compositor,
    // BrowserWindow and Canvas below use the actual Electron implementations.
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 17 })
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 18 })
    return
  }
  const window = new BrowserWindow({ show: false, width: 400, height: 240, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const painted = new Promise(resolve => window.once('ready-to-show', resolve))
  await window.loadURL('data:text/html,<canvas id="c" width="2" height="2"></canvas>')
  await painted
  const pixels = await window.webContents.executeJavaScript(`(()=>{const c=document.getElementById('c').getContext('2d',{willReadFrequently:true});c.fillStyle='rgb(10,20,30)';c.fillRect(0,0,2,2);return Array.from(c.getImageData(0,0,1,1).data)})()`)
  startupGraphics.windowReady()
  write({ event: 'window-ready', pixels, accelerated: app.isHardwareAccelerationEnabled(), features: app.getGPUFeatureStatus() })
  // Runtime GPU exits belong to playback recovery and must not relaunch the app.
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 19 })
  setTimeout(() => app.quit(), 200)
}).catch(error => { write({ event: 'harness-error', message: error.message }); app.exit(2) })
