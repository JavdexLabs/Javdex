// Run with Electron, not ELECTRON_RUN_AS_NODE. Uses no personal catalog or media.
const assert = require('node:assert/strict')
const path = require('node:path')
const { app, BrowserWindow, screen } = require('electron')

app.commandLine.appendSwitch('disable-direct-composition')
app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32')
  const window = new BrowserWindow({ show: false, width: 1000, height: 700 })
  const bridge = require(path.resolve(process.argv[2] || 'out/native-playback/playback.node'))
  try {
    await window.loadURL('data:text/html,<body>Playback geometry acceptance</body>')
    bridge.create(window.getNativeWindowHandle(), { x: 0, y: 0, width: 1, height: 1 })
    bridge.setRendererControls(true)
    const displayScale = screen.getDisplayMatching(window.getBounds()).scaleFactor
    // 1.925 reproduces 175% display scaling plus 110% accessibility text scaling.
    for (const scale of new Set([displayScale, 1, 1.75, 1.925, 2])) {
      for (const zoom of [1, 1.25, 1.5]) {
        window.webContents.setZoomFactor(zoom)
        for (const presentation of ['docked', 'expanded', 'fullscreen']) {
          bridge.setPresentation(presentation)
          bridge.setBounds({ x: 100 * zoom, y: 80 * zoom, width: 320 * zoom, height: 180 * zoom, scale })
          const state = bridge.inspect()
          assert.equal(state.surfaceX, Math.round(100 * zoom * scale), `${presentation}: x at ${scale}/${zoom}`)
          assert.equal(state.surfaceY, Math.round(80 * zoom * scale), `${presentation}: y at ${scale}/${zoom}`)
          assert.equal(state.surfaceWidth, Math.round(320 * zoom * scale), `${presentation}: width at ${scale}/${zoom}`)
          assert.equal(state.surfaceHeight, Math.round(180 * zoom * scale), `${presentation}: height at ${scale}/${zoom}`)
        }
      }
    }
    console.log(JSON.stringify({ status: 'passed', displayScale, dpi: bridge.inspect().dpi }))
  } finally {
    bridge.destroy()
    window.destroy()
  }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
