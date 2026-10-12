import assert from 'node:assert/strict'
import { test } from 'node:test'
import { playbackTime } from './playbackTime'

test('unknown duration stays unknown and clock formatting is stable', () => {
  assert.equal(playbackTime(null), '未知')
  assert.equal(playbackTime(NaN), '未知')
  assert.equal(playbackTime(3723.9), '01:02:03')
  assert.equal(playbackTime(-10), '00:00:00')
})
