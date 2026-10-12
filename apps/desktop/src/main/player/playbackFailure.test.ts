import assert from 'node:assert/strict'
import { test } from 'node:test'
import { structuredError } from '@shared/protocol/errors'
import { PlaybackFailure, playbackFailure } from './playbackFailure'

test('playback failures distinguish controlled causes without forwarding third-party messages', () => {
  const cases = [
    ['AUTH_REQUIRED', 'authorization'], ['WRITER_REVOKED', 'authorization'],
    ['ROOT_OFFLINE', 'root'], ['FILE_CHANGED', 'identity'],
    ['VERSION_MISMATCH', 'version'], ['CONNECTION_UNAVAILABLE', 'connection']
  ] as const
  for (const [code, expected] of cases) {
    const failure = playbackFailure(structuredError(code, 'https://server.invalid/play?token=secret /private/movie.mp4'))
    assert.equal(failure.code, expected)
    assert.ok(!failure.message.includes('secret'))
    assert.ok(!failure.message.includes('/private'))
  }
  assert.equal(playbackFailure(new Error('/private/movie.mp4')).code, 'load')
  const controlled = new PlaybackFailure('missing')
  assert.equal(playbackFailure(controlled), controlled)
})
