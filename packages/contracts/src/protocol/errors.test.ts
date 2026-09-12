import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DesktopIpcError,
  isStructuredError,
  structuredError,
  toStructuredError
} from './errors'

describe('structured IPC errors', () => {
  it('preserves managed codes instead of parsing the message', () => {
    const error = structuredError('VERSION_CONFLICT', '当前资料已更新，请确认后再保存')
    assert.equal(error.recovery, 'refreshAndConfirm')
    assert.equal(toStructuredError(error).code, 'VERSION_CONFLICT')
  })

  it('maps unknown thrown values to INVALID_INPUT without inspecting Chinese text', () => {
    const mapped = toStructuredError(new Error('当前资料已更新，请确认后再保存'))
    assert.equal(mapped.code, 'INVALID_INPUT')
    assert.equal(mapped.recovery, 'correctInput')
    assert.equal(mapped.message, '当前资料已更新，请确认后再保存')
  })

  it('exposes code and recovery on DesktopIpcError for renderer recovery', () => {
    const structured = structuredError('MODE_PREP_REQUIRED', '请先回到本地模式完成准备')
    const error = new DesktopIpcError(structured)
    assert.equal(error.message, structured.message)
    assert.equal(error.code, 'MODE_PREP_REQUIRED')
    assert.equal(error.recovery, 'returnToLocalPrep')
    assert.equal(isStructuredError(error), true)
  })
})
