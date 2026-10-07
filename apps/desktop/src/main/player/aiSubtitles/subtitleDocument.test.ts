import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderedCues, parseWhisperCues, renderSubtitleAss, renderSubtitleSrt } from './subtitleDocument'

test('chunk context timestamps return to media time and boundary cues belong to one chunk', () => {
  const input = { transcription: [{ offsets: { from: 1000, to: 5000 }, text: '前の台詞' },
    { offsets: { from: 4000, to: 7000 }, text: 'こんにちは' },
    { offsets: { from: 33000, to: 35000 }, text: '次の台詞' }] }
  const first = parseWhisperCues(input, 27, 30, 60)
  const second = parseWhisperCues(input, 27, 60, 90)
  assert.deepEqual(first, [{ start: 28, end: 32, japanese: '前の台詞' }, { start: 31, end: 34, japanese: 'こんにちは' }])
  assert.deepEqual(second, [{ start: 60, end: 62, japanese: '次の台詞' }])
})

test('SRT export uses media timestamps and the selected bilingual layout', () => {
  const cues = [{ start: 61.125, end: 63.5, japanese: 'こんにちは', chinese: '你好' }]
  assert.equal(renderSubtitleSrt(cues, 'bilingual'), '1\n00:01:01,125 --> 00:01:03,500\n你好\nこんにちは\n')
  assert.ok(!renderSubtitleSrt(cues, 'japanese').includes('你好'))
})
test('model text cannot inject ASS overrides or extra dialogue lines', () => {
  const value = renderSubtitleAss([{ start: 3670.12, end: 3674.5, japanese: '{\\pos(0,0)}日語\nDialogue: 0,evil', chinese: '中文' }], 'bilingual', 42)
  assert.equal(value.match(/^Dialogue:/gm)?.length, 1)
  assert.match(value, /1:01:10\.12,1:01:14\.50/)
  assert.ok(!value.includes('{\\pos'))
  assert.ok(value.includes('中文\\N{\\fs34}'))
})
test('missing translation preserves Japanese and repeated dialogue at different times remains', () => {
  const cues = [{ start: 0, end: 2, japanese: 'はい' }, { start: 0.2, end: 2.2, japanese: 'はい', chinese: '是' }, { start: 5, end: 7, japanese: 'はい' }]
  const merged = orderedCues(cues)
  assert.equal(merged.length, 2); assert.equal(merged[0].chinese, '是'); assert.equal(cues[0].chinese, undefined)
  assert.match(renderSubtitleAss(merged, 'chinese'), /はい/)
  assert.ok(!renderSubtitleAss(merged, 'japanese').includes('是'))
})
