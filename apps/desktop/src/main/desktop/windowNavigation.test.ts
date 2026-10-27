import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { BrowserWindow } from 'electron'
import { bindWindowNavigation, historyKey, navigateWindowHistory } from './windowNavigation'

test('history shortcuts do not intercept editing arrows, combinations, IME or repeats', () => {
  assert.equal(historyKey({ type: 'keyDown', key: 'ArrowLeft', alt: true }, 'win32'), 'back')
  assert.equal(historyKey({ type: 'keyDown', key: 'ArrowRight', alt: true }, 'linux'), 'forward')
  assert.equal(historyKey({ type: 'keyDown', key: 'ArrowLeft', alt: true }, 'darwin'), null)
  assert.equal(historyKey({ type: 'keyDown', key: 'ArrowRight', alt: true }, 'darwin'), null)
  assert.equal(historyKey({ type: 'keyDown', key: '[', meta: true }, 'darwin'), 'back')
  assert.equal(historyKey({ type: 'keyDown', key: ']', meta: true }, 'darwin'), 'forward')
  for (const input of [{ key: 'ArrowLeft' }, { key: 'ArrowLeft', alt: true, control: true }, { key: '[', meta: true, shift: true },
    { key: '[', meta: true, isComposing: true }, { key: '[', meta: true, isAutoRepeat: true }]) {
    assert.equal(historyKey({ type: 'keyDown', ...input }, 'darwin'), null)
  }
  assert.equal(historyKey({ type: 'keyDown', key: '[', meta: true }, 'linux'), null)
  assert.equal(historyKey({ type: 'keyDown', key: 'BrowserBack' }, 'linux'), 'back')
  assert.equal(historyKey({ type: 'keyDown', key: 'BrowserForward' }, 'linux'), 'forward')
  for (const platform of ['win32', 'darwin'] as const) {
    assert.equal(historyKey({ type: 'keyDown', key: 'BrowserBack' }, platform), null)
    assert.equal(historyKey({ type: 'keyDown', key: 'BrowserForward' }, platform), null)
  }
})
test('keyboard, app commands and legacy OS swipes use one bounded navigation entry with no duplicate bindings', () => {
  const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { navigationHistory: unknown }; isDestroyed(): boolean }
  let destroyed = false, canBack = true, back = 0, forward = 0, prevented = 0
  window.isDestroyed = () => destroyed
  window.webContents = Object.assign(new EventEmitter(), { navigationHistory: {
    canGoToOffset: (offset: number) => offset === -1 ? canBack : offset === 1,
    goToOffset: (offset: number) => { if (offset === -1) back++; else if (offset === 1) forward++; else assert.fail('must traverse one entry') }
  } })
  const target = window as unknown as BrowserWindow
  bindWindowNavigation(target, 'darwin'); bindWindowNavigation(target, 'darwin')
  window.webContents.emit('before-input-event', { preventDefault: () => prevented++ }, { type: 'keyDown', key: 'ArrowLeft', alt: true })
  assert.equal(back, 0); assert.equal(prevented, 0, 'Option-arrows must remain available for macOS text editing')
  window.webContents.emit('before-input-event', { preventDefault: () => prevented++ }, { type: 'keyDown', key: '[', meta: true })
  window.emit('app-command', {}, 'browser-backward')
  window.emit('swipe', {}, 'right')
  window.emit('app-command', {}, 'browser-forward')
  assert.equal(back, 3); assert.equal(forward, 1); assert.equal(prevented, 1)
  canBack = false; navigateWindowHistory(target, 'back'); assert.equal(back, 3)
  destroyed = true; navigateWindowHistory(target, 'forward'); assert.equal(forward, 1)
})

test('history entries respect earlier event vetoes and a foreground task across keyboard, OS and native input', () => {
  const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { navigationHistory: unknown }; isDestroyed(): boolean }
  let blocked = true, navigations = 0
  window.isDestroyed = () => false
  window.webContents = Object.assign(new EventEmitter(), { navigationHistory: {
    canGoToOffset: () => true, goToOffset: () => navigations++
  } })
  const target = window as unknown as BrowserWindow
  bindWindowNavigation(target, 'darwin', () => !blocked)
  const veto = { defaultPrevented: true, preventDefault: () => assert.fail('must respect the preceding guard') }
  window.webContents.emit('before-input-event', veto, { type: 'keyDown', key: '[', meta: true })
  window.emit('app-command', veto, 'browser-backward')
  window.emit('swipe', veto, 'right')
  window.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'ArrowLeft', alt: true })
  window.emit('app-command', {}, 'browser-forward')
  window.emit('swipe', {}, 'left')
  navigateWindowHistory(target, 'back')
  assert.equal(navigations, 0)
  blocked = false
  window.webContents.emit('before-input-event', veto, { type: 'keyDown', key: '[', meta: true })
  assert.equal(navigations, 0, 'an unrelated veto still applies after the task is no longer blocking')
  navigateWindowHistory(target, 'back')
  assert.equal(navigations, 1)
})

test('native re-expansion traverses a real entry even when Chromium UI Back would skip it', () => {
  const offsets: number[] = []
  let available = true
  const window = {
    isDestroyed: () => false,
    webContents: { navigationHistory: {
      canGoBack: () => false, canGoForward: () => false,
      goBack: () => assert.fail('UI Back may skip the viewing entry'),
      goForward: () => assert.fail('UI Forward may skip the viewing entry'),
      canGoToOffset: (offset: number) => available && (offset === -1 || offset === 1),
      goToOffset: (offset: number) => offsets.push(offset)
    } }
  }
  navigateWindowHistory(window, 'back')
  navigateWindowHistory(window, 'forward')
  assert.deepEqual(offsets, [-1, 1])
  available = false
  navigateWindowHistory(window, 'back')
  navigateWindowHistory(window, 'forward')
  assert.deepEqual(offsets, [-1, 1], 'history boundaries still prevent navigation')
})

test('Linux side-button press/release cannot perform a second Chromium navigation or bypass a foreground guard', () => {
  const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { navigationHistory: unknown }; isDestroyed(): boolean }
  let allowed = true, index = 4
  window.isDestroyed = () => false
  window.webContents = Object.assign(new EventEmitter(), { navigationHistory: {
    canGoToOffset: (offset: number) => index + offset >= 0 && index + offset <= 5,
    goToOffset: (offset: number) => { index += offset }
  } })
  const target = window as unknown as BrowserWindow
  bindWindowNavigation(target, 'linux', () => allowed)
  bindWindowNavigation(target, 'linux', () => allowed)
  assert.equal(window.webContents.listenerCount('before-mouse-event'), 1)
  for (const button of ['back', 'forward']) {
    let prevented = 0
    window.emit('app-command', {}, button === 'back' ? 'browser-backward' : 'browser-forward')
    const afterCommand = index
    for (const type of ['mouseDown', 'mouseUp']) {
      window.webContents.emit('before-mouse-event', { preventDefault: () => prevented++ }, { type, button })
    }
    assert.equal(prevented, 2, 'consume both halves of the native side-button click')
    assert.equal(index, afterCommand, 'the mouse event must not initiate another traversal')
    allowed = false
    window.emit('app-command', {}, button === 'back' ? 'browser-backward' : 'browser-forward')
    window.webContents.emit('before-mouse-event', { preventDefault: () => prevented++ }, { type: 'mouseUp', button })
    assert.equal(index, afterCommand)
    assert.equal(prevented, 3, 'blocked app commands must not fall through to Chromium navigation')
    allowed = true
  }
  assert.equal(index, 4, 'one Back and one Forward return to the original entry')
  for (const button of ['left', 'middle', 'right', 'none', 'eraser', undefined]) {
    window.webContents.emit('before-mouse-event', { preventDefault: () => assert.fail('ordinary mouse input must reach the page') }, { type: 'mouseUp', button })
  }
  window.webContents.emit('before-mouse-event', { defaultPrevented: true, preventDefault: () => assert.fail('respect earlier vetoes') }, { type: 'mouseUp', button: 'back' })
})

test('Linux mouse suppression does not change Windows or macOS event handling', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { navigationHistory: unknown }; isDestroyed(): boolean }
    window.isDestroyed = () => false
    window.webContents = Object.assign(new EventEmitter(), { navigationHistory: { canGoToOffset: () => true, goToOffset() {} } })
    bindWindowNavigation(window as unknown as BrowserWindow, platform)
    assert.equal(window.webContents.listenerCount('before-mouse-event'), 0)
  }
})

test('Linux browser keys consume release and repeats without duplicating navigation or bypassing earlier guards', () => {
  const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { navigationHistory: unknown }; isDestroyed(): boolean }
  let allowed = true, index = 4
  window.isDestroyed = () => false
  window.webContents = Object.assign(new EventEmitter(), { navigationHistory: {
    canGoToOffset: (offset: number) => index + offset >= 0 && index + offset <= 5,
    goToOffset: (offset: number) => { index += offset }
  } })
  bindWindowNavigation(window as unknown as BrowserWindow, 'linux', () => allowed)
  const keyEvent = (key: string, fields: Record<string, unknown> = {}): boolean => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    window.webContents.emit('before-input-event', event, { type: 'keyDown', key, ...fields })
    // Model Linux's unhandled-key fallback into the native app-command path.
    if (!event.defaultPrevented) window.emit('app-command', {}, key === 'BrowserBack' ? 'browser-backward' : 'browser-forward')
    return event.defaultPrevented
  }
  for (const [key, expected] of [['BrowserBack', 3], ['BrowserForward', 4]] as const) {
    assert.equal(keyEvent(key), true)
    assert.equal(index, expected)
    for (const fields of [{ isAutoRepeat: true }, { type: 'keyUp' }, { isComposing: true }, { control: true }, { alt: true }, { shift: true }, { meta: true }]) {
      assert.equal(keyEvent(key, fields), true)
      assert.equal(index, expected)
    }
    allowed = false
    assert.equal(keyEvent(key), true)
    assert.equal(keyEvent(key, { type: 'keyUp' }), true)
    assert.equal(index, expected)
    allowed = true
    window.webContents.emit('before-input-event', { defaultPrevented: true, preventDefault: () => assert.fail('respect an earlier veto') }, { type: 'keyDown', key })
    assert.equal(index, expected)
  }
})
