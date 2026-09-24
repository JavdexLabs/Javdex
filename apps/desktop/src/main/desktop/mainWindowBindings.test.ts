import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bindMainWindow, registerMainWindowBinder } from './mainWindowBindings'

function fakeWindow(): { isDestroyed: () => boolean } {
  return { isDestroyed: () => false }
}

describe('mainWindowBindings', () => {
  it('notifies binders for a recreated window without requiring IPC re-registration', () => {
    const seen: string[] = []
    const first = fakeWindow()
    const second = fakeWindow()
    const stop = registerMainWindowBinder((window) => {
      seen.push(window === first ? 'first' : window === second ? 'second' : 'other')
    })
    try {
      bindMainWindow(first)
      bindMainWindow(second)
      assert.deepEqual(seen, ['first', 'second'])
    } finally {
      stop()
    }
    bindMainWindow(first)
    assert.deepEqual(seen, ['first', 'second'])
  })
})
