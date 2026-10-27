// Hidden test windows only. Win32 messages target this process's own children;
// this host never moves the pointer, takes foreground focus, or loads user media.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { app, BrowserWindow } = require('electron')
const directory = process.argv[2]
const { bindWindowNavigation, navigateWindowHistory } = require(path.join(directory, 'navigation.cjs'))
const native = process.argv.includes('--native')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
app.setPath('userData', path.join(directory, 'profile'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

async function until(read, predicate, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await delay(20)
  }
  throw new Error(`Timeout: ${label}`)
}

app.whenReady().then(async () => {
  const steps = []
  let window, bridge
  try {
    window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true } })
    const contents = window.webContents
    const history = contents.navigationHistory
    const evaluate = code => contents.executeJavaScript(code)
    const read = () => evaluate('({state: window.playbackHistoryFixture?.snapshot(), marker: history.state?.avOverlay, url: location.hash})')
    const waitPresentation = presentation => until(read, value => value.state?.presentation === presentation, presentation)
    let appCommands = 0
    let canNavigate = true
    window.on('app-command', () => { appCommands++ })
    bindWindowNavigation(window, process.platform, () => canNavigate)
    const linuxMouse = process.platform === 'linux'
    if (linuxMouse) contents.debugger.attach('1.3')
    const sendHistoryCommand = async direction => {
      const button = direction === 'back' ? 'back' : 'forward'
      // CDP supplies real mouse events (sendInputEvent cannot express side
      // buttons); replay the preceding Linux native-window app-command too.
      if (linuxMouse) await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: 200, y: 200, button, buttons: direction === 'back' ? 8 : 16, clickCount: 1
      })
      window.emit('app-command', { defaultPrevented: false }, direction === 'back' ? 'browser-backward' : 'browser-forward')
      if (linuxMouse) {
        await delay(100)
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 200, button, buttons: 0, clickCount: 1 })
      }
    }
    await window.loadFile(path.join(directory, 'index.html'), { hash: '/libraries/1' })
    await until(() => evaluate('Boolean(window.playbackHistoryFixture && document.querySelector("main"))'), Boolean, 'renderer startup')
    await evaluate('window.playbackHistoryFixture.detail()')
    const detailIndex = history.getActiveIndex()
    const detailRoute = '#/libraries/1/video/2'
    let sendMessage
    if (native) {
      assert.equal(process.platform, 'win32')
      bridge = require(path.resolve('out/native-playback/playback.node'))
      bridge.create(window.getNativeWindowHandle(), { x: 0, y: 0, width: 320, height: 180 })
      const helper = path.join(directory, 'message.ps1')
      fs.writeFileSync(helper, `\uFEFFparam([long]$PlayerHandle, [uint32]$ExpectedProcessId, [string]$Target, [string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PlaybackHistoryMessage {
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
  public static void Send(IntPtr parent, uint expected, string target, string action) {
    uint owner; GetWindowThreadProcessId(parent, out owner);
    if (owner != expected) throw new Exception("Refusing an unrelated window");
    IntPtr child = IntPtr.Zero;
    EnumChildWindows(parent, (window, data) => {
      var klass = new StringBuilder(256); var title = new StringBuilder(256);
      GetClassName(window, klass, 256); GetWindowText(window, title, 256);
      if (target == "video" ? klass.ToString() == "JavdexLibmpvSurface" && title.ToString() == "\u89c6\u9891\u753b\u9762" : klass.ToString() == "Button" && GetDlgCtrlID(window) == 1) child = window;
      return true;
    }, IntPtr.Zero);
    if (child == IntPtr.Zero) throw new Exception("Native playback target missing");
    uint message = action == "down" ? 0x020Bu : action == "up" ? 0x020Cu : action == "click" ? 0x0201u : 0x0202u;
    UIntPtr result;
    if (SendMessageTimeout(child, message, new UIntPtr(action == "down" || action == "up" ? 1u << 16 : 0u), new IntPtr(10 | (10 << 16)), 2, 2000, out result) == IntPtr.Zero) throw new Exception("Native message rejected");
  }
}
'@
[PlaybackHistoryMessage]::Send([IntPtr]$PlayerHandle, $ExpectedProcessId, $Target, $Action)
Write-Output 'message-sent'
`)
      sendMessage = async (target, action) => {
        const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper,
        '-PlayerHandle', window.getNativeWindowHandle().readBigInt64LE().toString(), '-ExpectedProcessId', String(process.pid), '-Target', target, '-Action', action], { windowsHide: true, timeout: 10000 })
        assert.equal(stdout.trim(), 'message-sent')
      }
    }
    const drain = async expected => {
      const actions = bridge.state().actions ?? []
      assert.deepEqual(actions.map(action => action.kind), expected)
      for (const action of actions) {
        if (action.kind === 'expand') await evaluate('window.playbackHistoryFixture.expand()')
        else navigateWindowHistory(window, action.kind === 'history-back' ? 'back' : 'forward')
      }
    }
    for (let cycle = 0; cycle < 5; cycle++) {
      if (!cycle) await contents.executeJavaScript('window.playbackHistoryFixture.open()', true)
      else if (native) {
        await sendMessage('video', 'click'); await sendMessage('video', 'release')
        await drain(['expand'])
      } else await evaluate('window.playbackHistoryFixture.expand()')
      await waitPresentation('expanded')
      await until(read, value => Boolean(value.marker), 'viewing marker')
      if (cycle === 2) {
        await evaluate('document.querySelector("button[aria-label=全屏]").click()')
        await waitPresentation('fullscreen')
      }
      const before = { index: history.getActiveIndex(), uiBack: history.canGoBack(), exactBack: history.canGoToOffset(-1) }
      assert.equal(before.index, detailIndex + 1)
      if (native) {
        bridge.setPresentation(cycle === 2 ? 'fullscreen' : 'expanded')
        const target = cycle === 2 ? 'control' : 'video'
        await sendMessage(target, 'down')
        await drain([])
        assert.equal(history.getActiveIndex(), before.index, 'press cannot navigate before release')
        await sendMessage(target, 'up')
        await drain(['history-back'])
      } else await sendHistoryCommand('back')
      const after = await waitPresentation('docked')
      if (native) bridge.setPresentation('docked')
      await delay(100)
      assert.equal(history.getActiveIndex(), detailIndex, 'exactly one viewing step consumed')
      assert.equal(after.url, detailRoute)
      assert.equal(after.state.sessionId, 'history-fixture')
      assert.equal(after.state.position, 1)
      assert.equal(after.marker, undefined)
      if (native) assert.equal(appCommands, 0, 'native release cannot also dispatch an outer app-command')
      steps.push({ cycle, before, after })
    }
    assert.ok(steps.slice(1).some(step => !step.before.uiBack && step.before.exactBack), 'fixture must reproduce Chromium UI-skippable viewing entries')
    if (linuxMouse) {
      canNavigate = false
      await sendHistoryCommand('back')
      await delay(200)
      assert.equal(history.getActiveIndex(), detailIndex, 'a foreground guard must block the Chromium mouse default too')
      canNavigate = true
      await sendHistoryCommand('back')
    } else navigateWindowHistory(window, 'back')
    await until(read, value => value.url === '#/libraries/1', 'business Back while docked')
    if (linuxMouse) {
      await sendHistoryCommand('forward')
      await until(read, value => value.url === detailRoute, 'business Forward')
      await delay(200)
      assert.equal(history.getActiveIndex(), detailIndex, 'Forward must not also enter the anonymous viewing entry')
      assert.equal((await read()).state.presentation, 'docked', 'Forward must not resurrect an ended viewing overlay')
    }
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ passed: true, electron: process.versions.electron,
      ozonePlatform: app.commandLine.getSwitchValue('ozone-platform') || null, native, linuxMouse, steps }, null, 2))
    console.log(`Playback navigation passed: ${steps.length} cycles; native Win32 messages: ${native}`)
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'error.txt'), error.stack)
    console.error(error)
    process.exitCode = 1
  } finally {
    bridge?.destroy()
    window?.destroy()
    app.exit(process.exitCode ?? 0)
  }
}).catch(error => { console.error(error); app.exit(1) })
