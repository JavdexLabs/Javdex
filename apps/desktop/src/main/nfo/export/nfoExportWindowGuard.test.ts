import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bindNfoExportWindowGuard } from './nfoExportWindowGuard'

describe('NFO export main-window guard', () => {
  it('binds recreated windows and disposes a foreground task when their renderer is lost', async () => {
    const first = new EventEmitter()
    const reopened = new EventEmitter()
    let disposals = 0
    const controller = {
      isForegroundBlocking: true,
      hasActivePlanOrTask: true,
      dispose: async () => { disposals += 1 }
    }
    const firstWindow = Object.assign(new EventEmitter(), { webContents: first })
    const reopenedWindow = Object.assign(new EventEmitter(), { webContents: reopened })
    bindNfoExportWindowGuard(firstWindow as never, controller)
    bindNfoExportWindowGuard(reopenedWindow as never, controller)

    reopened.emit('destroyed')
    await Promise.resolve()
    assert.equal(disposals, 1)
  })

  it('prevents navigation while a plan or task owns the foreground', () => {
    const contents = new EventEmitter()
    const window = Object.assign(new EventEmitter(), { webContents: contents })
    const controller = {
      isForegroundBlocking: true,
      hasActivePlanOrTask: true,
      dispose: async () => undefined
    }
    bindNfoExportWindowGuard(window as never, controller)
    let prevented = 0
    const event = { preventDefault: () => { prevented += 1 } }
    contents.emit('will-navigate', event)
    contents.emit('will-frame-navigate', event)
    contents.emit('before-input-event', event, {
      type: 'keyDown', key: 'k', alt: false, control: false, meta: true
    })
    assert.equal(prevented, 3)
  })

  it('keeps the window open during a running export but allows the coordinated quit path', () => {
    const contents = new EventEmitter()
    const window = Object.assign(new EventEmitter(), { webContents: contents })
    const controller = {
      isForegroundBlocking: true,
      hasActivePlanOrTask: true,
      dispose: async () => undefined
    }
    let quitting = false
    bindNfoExportWindowGuard(window as never, controller, () => quitting)
    let prevented = 0
    const event = { preventDefault: () => { prevented += 1 } }

    window.emit('close', event)
    contents.emit('will-prevent-unload', event)
    quitting = true
    window.emit('close', event)
    contents.emit('will-prevent-unload', event)
    assert.equal(prevented, 2)
  })

  it('releases a held preview plan and allows navigation instead of treating it as a running task', async () => {
    const contents = new EventEmitter()
    const window = Object.assign(new EventEmitter(), { webContents: contents })
    let disposals = 0
    const controller = {
      isForegroundBlocking: false,
      hasActivePlanOrTask: true,
      dispose: async () => { disposals += 1 }
    }
    bindNfoExportWindowGuard(window as never, controller)
    let prevented = 0
    contents.emit('will-navigate', { preventDefault: () => { prevented += 1 } })
    await Promise.resolve()
    assert.equal(prevented, 0)
    assert.equal(disposals, 1)
  })
})
