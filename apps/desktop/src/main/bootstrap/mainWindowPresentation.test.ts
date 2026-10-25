import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { BrowserWindow } from 'electron'
import { bindMainWindowPresentation } from './mainWindowPresentation'

for (const first of ['ready-to-show', 'did-finish-load']) {
  test(`main window displays once when ${first} arrives first`, () => {
    let shows = 0, ready = 0
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(),
      isDestroyed: () => false, show: () => { shows++ } })
    bindMainWindowPresentation(window as unknown as BrowserWindow, {
      canContinue: () => true, windowReady: () => { ready++ }
    }, true)
    if (first === 'ready-to-show') window.emit(first)
    else window.webContents.emit(first)
    assert.equal(shows, 1, 'loading alone must unblock a compositor that cannot paint hidden windows')
    window.emit('ready-to-show'); window.webContents.emit('did-finish-load')
    assert.equal(shows, 1); assert.equal(ready, 1)
  })
}

for (const reason of ['destroyed', 'cancelled']) {
  test(`late load or paint cannot show a ${reason} startup window`, () => {
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(),
      isDestroyed: () => reason === 'destroyed', show: () => assert.fail('must not show') })
    bindMainWindowPresentation(window as unknown as BrowserWindow, {
      canContinue: () => reason !== 'cancelled', windowReady: () => assert.fail('must not mark ready')
    }, true)
    window.webContents.emit('did-finish-load'); window.emit('ready-to-show')
  })
}

test('hardware startup still waits for its first paint after loading', () => {
  let shows = 0, ready = 0
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter(),
    isDestroyed: () => false, show: () => { shows++ } })
  bindMainWindowPresentation(window as unknown as BrowserWindow, {
    canContinue: () => true, windowReady: () => { ready++ }
  })
  window.webContents.emit('did-finish-load')
  assert.equal(shows, 0); assert.equal(ready, 0)
  window.emit('ready-to-show')
  assert.equal(shows, 1); assert.equal(ready, 1)
})
