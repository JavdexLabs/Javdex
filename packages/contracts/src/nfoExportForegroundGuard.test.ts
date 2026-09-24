import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldBlockNfoExportShortcut } from './nfoExportForegroundGuard'

describe('NFO export foreground shortcut guard', () => {
  it('blocks reload, history, close, and application navigation shortcuts', () => {
    for (const input of [
      { key: 'F5' },
      { key: 'r', metaKey: true },
      { key: 'R', ctrlKey: true },
      { key: 'ArrowLeft', altKey: true },
      { key: '[', metaKey: true },
      { key: 'w', ctrlKey: true },
      { key: 'k', metaKey: true }
    ]) {
      assert.equal(shouldBlockNfoExportShortcut(input), true, JSON.stringify(input))
    }
  })

  it('leaves modal controls and copy shortcuts usable', () => {
    assert.equal(shouldBlockNfoExportShortcut({ key: 'Tab' }), false)
    assert.equal(shouldBlockNfoExportShortcut({ key: 'Enter' }), false)
    assert.equal(shouldBlockNfoExportShortcut({ key: 'c', metaKey: true }), false)
  })
})
