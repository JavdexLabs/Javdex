import assert from 'node:assert/strict'
import { test } from 'node:test'
import { structuredError } from '@shared/protocol/errors'
import { PlaybackFailure, playbackFailure } from './playbackFailure'

test('playback failures distinguish controlled causes without forwarding third-party messages', () => {
  const cases = [
    ['AUTH_REQUIRED', 'authorization'], ['WRITER_REVOKED', 'authorization'],
    ['ROOT_OFFLINE', 'root'], ['FILE_CHANGED', 'identity'],
    ['VERSION_MISMATCH', 'version'], ['CONNECTION_UNAVAILABLE', 'connection'],
    ['FILE_MISSING', 'missing'], ['FILE_ACCESS_DENIED', 'permission']
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

test('restart-required native failures retain their controlled recovery instruction for every fallback', () => {
  const error = Object.assign(new Error('/private/movie.mp4?token=secret'), { code: 'PLAYBACK_RESTART_REQUIRED' })
  for (const fallback of ['load', 'video', 'native', 'runtime'] as const) {
    const failure = playbackFailure(error, fallback)
    assert.match(failure.message, /重启应用/)
    assert.ok(!failure.message.includes('/private'))
    assert.ok(!failure.message.includes('secret'))
  }
})
