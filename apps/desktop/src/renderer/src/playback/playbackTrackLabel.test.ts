import assert from 'node:assert/strict'
import test from 'node:test'
import type { PlaybackTrack } from '@shared/desktop/playback'
import { playbackTrackLabel } from './playbackTrackLabel'

const track: PlaybackTrack = { id: 2, type: 'audio', title: 'Dub', language: 'jpn', codec: 'ac3', channelCountHint: 6, selected: false }
test('track title does not hide language, codec or channel hint', () => {
  assert.equal(playbackTrackLabel(track), 'Dub · jpn · AC3 · 6 声道')
})
test('unknown metadata stays absent and subtitles never present audio channel hints', () => {
  assert.equal(playbackTrackLabel({ ...track, title: ' ', language: null, codec: null, channelCountHint: null }), '音轨 2')
  assert.equal(playbackTrackLabel({ ...track, type: 'sub', title: null, codec: 'ass', channelCountHint: null }), '字幕 2 · jpn · ASS')
})
