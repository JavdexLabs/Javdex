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
