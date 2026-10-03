import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { BrowserWindow } from 'electron'
import { bindWindowNavigation, historyKey, navigateWindowHistory } from './windowNavigation'

test('history shortcuts do not intercept editing arrows, combinations, IME or repeats', () => {
  assert.equal(historyKey({ type: 'keyDown', key: 'ArrowLeft', alt: true }, 'win32'), 'back')
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
    canGoBack: () => canBack, canGoForward: () => true, goBack: () => back++, goForward: () => forward++
  } })
  const target = window as unknown as BrowserWindow
  bindWindowNavigation(target, 'darwin'); bindWindowNavigation(target, 'darwin')
  window.webContents.emit('before-input-event', { preventDefault: () => prevented++ }, { type: 'keyDown', key: '[', meta: true })
  window.emit('app-command', {}, 'browser-backward')
  window.emit('swipe', {}, 'right')
  window.emit('app-command', {}, 'browser-forward')
  assert.equal(back, 3); assert.equal(forward, 1); assert.equal(prevented, 1)
  canBack = false; navigateWindowHistory(target, 'back'); assert.equal(back, 3)
  destroyed = true; navigateWindowHistory(target, 'forward'); assert.equal(forward, 1)
})
