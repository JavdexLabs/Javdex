import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  auditRowHeight,
  isCompactAuditRow,
  shouldVirtualizeAuditRows
} from './libraryScanAuditLayout'

describe('library scan audit row layout', () => {
  it('uses compact rows only when the skipped tab also uses compact virtual slots', () => {
    assert.equal(auditRowHeight('all'), 72)
    assert.equal(isCompactAuditRow('all', 'skipped'), false)

    assert.equal(auditRowHeight('skipped'), 48)
    assert.equal(isCompactAuditRow('skipped', 'skipped'), true)
  })

  it('keeps the variable-height attention list out of fixed-size virtualization', () => {
    assert.equal(shouldVirtualizeAuditRows('failed', 100), false)
    assert.equal(shouldVirtualizeAuditRows('all', 9), true)
    assert.equal(shouldVirtualizeAuditRows('all', 8), false)
  })

  it('keeps CSS row geometry aligned with virtual item sizes', () => {
    const css = readFileSync(
      new URL('./LibraryScanAuditPanel.module.css', import.meta.url),
      'utf8'
    )

    assert.match(css, /\.rowSlot\s*{[^}]*padding-bottom:\s*8px;/s)
    assert.match(css, /\.row\s*{[^}]*min-height:\s*64px;/s)
    assert.match(css, /\.skippedRow\s*{[^}]*min-height:\s*40px;/s)
  })
})
