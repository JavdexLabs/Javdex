// Isolated Win32 SendInput regression. Run with Electron, not ELECTRON_RUN_AS_NODE.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { app, BrowserWindow, screen } = require('electron')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
app.commandLine.appendSwitch('disable-direct-composition')
app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32')
  const output = path.resolve('out/playback-focus-acceptance')
  fs.mkdirSync(output, { recursive: true })
  const helper = path.join(output, 'click.ps1')
  fs.writeFileSync(helper, `param([long]$PlayerHandle, [int]$ClickX, [int]$ClickY)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PlaybackFocusInput {
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int x, y; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public MouseInput mouse; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
  public static void Click(int x, int y) {
    if (!SetCursorPos(x, y)) throw new Exception("Cannot position test pointer");
    var inputs = new Input[] { new Input { mouse = new MouseInput { flags = 2 } }, new Input { mouse = new MouseInput { flags = 4 } } };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2) throw new Exception("SendInput failed");
  }
}
'@
$point = [PlaybackFocusInput+Point]@{x=$ClickX;y=$ClickY}
if (![PlaybackFocusInput]::ClientToScreen([IntPtr]$PlayerHandle, [ref]$point)) { throw 'Cannot locate native player surface' }
[PlaybackFocusInput]::Click($point.x, $point.y)
[System.Threading.Thread]::Sleep(100)
$underPointer = [PlaybackFocusInput]::WindowFromPoint($point)
@{ foreground = [PlaybackFocusInput]::GetForegroundWindow().ToInt64(); targetRoot = [PlaybackFocusInput]::GetAncestor($underPointer, 2).ToInt64() } | ConvertTo-Json -Compress
`)
  const click = (handle, point) => new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      String(handle), String(point.x), String(point.y)], { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)))
  })
  const window = new BrowserWindow({ show: false, x: 100, y: 100, width: 800, height: 600 })
  const cover = new BrowserWindow({ show: false, x: 680, y: 100, width: 250, height: 250 })
  window.setAlwaysOnTop(true, 'screen-saver')
  cover.setAlwaysOnTop(true, 'screen-saver')
  const bridge = require(path.resolve(process.argv[2] || 'out/native-playback/playback.node'))
  let timer
  let tickError
  const actions = []
  try {
    await window.loadURL('data:text/html,<body>Playback focus regression</body>')
    await cover.loadURL('data:text/html,<body>Cover window</body>')
    const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor
    bridge.create(window.getNativeWindowHandle(), { x: 20, y: 20, width: 700, height: 420, scale })
    bridge.setRendererControls(true)
    bridge.setVisible(true)
    bridge.command(['loadfile', path.resolve('out/playback-acceptance/synthetic-h264.mp4'), 'replace'])
    timer = setInterval(() => {
      try {
        bridge.render()
        const state = bridge.state()
        for (const action of state.actions || []) {
          actions.push(action)
          if (action.kind === 'toggle-pause') bridge.command(['cycle', 'pause'])
        }
      } catch (error) { tickError = error }
    }, 10)
    window.show()
    await delay(500)
    for (const presentation of ['expanded', 'fullscreen']) {
      bridge.setPresentation(presentation)
      bridge.command(['set', 'pause', 'no'])
      cover.show(); cover.focus()
      await delay(200)
      assert.equal(cover.isFocused(), true, 'cover window must initially own focus')
      const native = bridge.inspect()
      const point = { x: Math.round(native.surfaceX + native.surfaceWidth * 0.25), y: Math.round(native.surfaceY + native.surfaceHeight * 0.5) }
      const windowHandle = Number(window.getNativeWindowHandle().readBigUInt64LE())
      actions.length = 0
      const activation = await click(windowHandle, point)
      await delay(800)
      if (tickError) throw tickError
      assert.equal(activation.foreground, windowHandle, `${presentation}: activation click must focus the player window`)
      assert.equal(actions.some(action => action.kind === 'toggle-pause'), false, `${presentation}: activation click must not pause playback`)
      assert.equal(bridge.inspect().pause, false, `${presentation}: video must remain playing`)
      await click(windowHandle, point)
      await delay(800)
      if (tickError) throw tickError
      assert.equal(actions.filter(action => action.kind === 'toggle-pause').length, 1, `${presentation}: subsequent click must still toggle pause once`)
      assert.equal(bridge.inspect().pause, true, `${presentation}: ordinary click must pause the video`)
    }
    console.log(JSON.stringify({ status: 'passed', platform: 'win32', presentations: ['expanded', 'fullscreen'], input: 'SendInput', checks: 10 }))
  } finally {
    clearInterval(timer)
    bridge.destroy()
    cover.destroy(); window.destroy()
  }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
