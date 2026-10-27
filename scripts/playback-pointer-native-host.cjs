const { app, BrowserWindow } = require('electron')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const directory = process.argv[2]
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.setPath('userData', path.join(directory, 'profile'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  let window, failure
  const results = []
  const timing = await require(path.join(directory, 'pointer-timing.cjs')).readPointerTiming()
  try {
    window = new BrowserWindow({ title: 'Javdex 点击手势验收（自动关闭）', frame: false, alwaysOnTop: true, webPreferences: { sandbox: true } })
    window.setFullScreen(true)
    const contents = window.webContents
    let lastMouse = null
    const events = []
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseMove') lastMouse = mouse
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp') events.push({ ...mouse, time: Date.now() })
    })
    const inject = (...args) => promisify(execFile)('/usr/bin/python3', [path.join(__dirname, 'playback-pointer-mutter.py'), ...args.map(String)], { timeout: 10000 })
    const cases = [{ gap: 450, hold: 0, double: true }, { gap: 450, hold: 800, double: true }, { gap: 510, hold: 0, double: false }]
    for (const surface of ['gpu', 'cpu']) for (const paused of [true, false]) for (const item of cases) {
      await window.loadFile(path.join(directory, 'index.html'), { query: { surface, doubleClickMs: String(timing.doubleClickMs), ...(paused ? {} : { playing: '1' }) } })
      window.focus()
      await delay(500)
      lastMouse = null
      await inject('move', 1, 1)
      const deadline = Date.now() + 3000
      while (!lastMouse && Date.now() < deadline) await delay(20)
      assert.ok(lastMouse, 'Native pointer motion must reach the owned window')
      for (let attempt = 0; attempt < 4; attempt++) {
        const rect = await contents.executeJavaScript('(() => { const r=document.querySelector("video[data-playback-surface]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()')
        await inject('move', rect.x - lastMouse.x, rect.y - lastMouse.y)
        const target = await contents.executeJavaScript(`Boolean(document.elementFromPoint(${lastMouse.x},${lastMouse.y})?.closest('button[aria-label="视频画面，单击播放或暂停，双击全屏"]'))`)
        if (target) break
        assert.notEqual(attempt, 3, 'Refuse to inject outside the owned video surface')
      }
      assert.ok(window.isFocused() && await contents.executeJavaScript('document.hasFocus()'), 'Refuse injection when another window has focus')
      const start = events.length
      await inject('pair', item.gap, item.hold)
      await delay(timing.doubleClickMs + 100)
      const commands = await contents.executeJavaScript('window.fixtureCommands')
      const nativeEvents = events.slice(start)
      assert.deepEqual(nativeEvents.filter(event => event.type === 'mouseDown').map(event => event.clickCount), item.double ? [1, 2] : [1, 1], 'Verify actual runtime multi-click classification around the deadline')
      assert.deepEqual(commands, item.double ? [{ kind: 'presentation', value: 'fullscreen' }]
        : [{ kind: 'pause', paused: !paused }, { kind: 'pause', paused }], 'Double click only changes presentation; two independent clicks must both activate')
      results.push({ surface, paused, ...item, commands, nativeEvents })
      console.log('PASS', JSON.stringify({ surface, paused, ...item }))
    }
  } catch (error) { failure = error.stack; console.error(error); process.exitCode = 1 }
  finally {
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ passed: !failure, electron: process.versions.electron,
      chromium: process.versions.chrome, platform: app.commandLine.getSwitchValue('ozone-platform'), timing, results, failure }, null, 2))
    window?.destroy()
    app.exit(process.exitCode || 0)
  }
})
