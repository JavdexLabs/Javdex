import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePlaybackTime, playbackTime } from './playbackTime'

test('exact time accepts seconds and clock input without coercing invalid values', () => {
  for (const [input, seconds] of [['0', 0], [' 90 ', 90], ['1:30', 90], ['01:02:03', 3723], ['100:00', 6000], ['604800', 604800]] as const) {
    assert.equal(parsePlaybackTime(input), seconds)
  }
  for (const input of ['', ' ', '-1', '1.5', '1e3', '1:60', '1:99:00', '00::01', '1:2:3:4', 'Infinity', '604801', '9007199254740993']) {
    assert.equal(parsePlaybackTime(input), null, input)
  }
})
test('unknown duration stays unknown and clock formatting is stable', () => {
  assert.equal(playbackTime(null), '未知')
  assert.equal(playbackTime(NaN), '未知')
  assert.equal(playbackTime(3723.9), '01:02:03')
  assert.equal(playbackTime(-10), '00:00:00')
})
