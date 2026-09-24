import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BROWSER_FORBIDDEN_FIELDS } from './dto'
import type { WebDetail, WebVideo } from '../webTypes'
import { EMPTY_DESKTOP_SESSION } from '../desktop/session'

test('browser DTOs stay on a path-free whitelist', () => {
  const video: WebVideo = {
    id: 1,
    code: 'ABC-001',
    title: 'Demo',
    cover: '/api/videos/1/cover',
    releaseDate: null,
    duration: 90,
    rating: 0
  }
  const detail: WebDetail = {
    ...video,
    summary: 'ok',
    maker: null,
    publisher: null,
    series: null,
    director: null,
    actresses: [],
    tags: [],
    images: ['/api/videos/1/images/1'],
    resources: [
      {
        id: 9,
        libraryId: 1,
        isPrimary: true,
        name: 'clip',
        kind: 'local',
        format: 'mp4',
        sizeBytes: 10,
        durationSeconds: 90,
        libraryName: 'lib',
        downloadUrl: '/api/videos/1/file',
        link: null,
        mime: 'video/mp4',
        playable: true,
        reason: null
      }
    ]
  }
  const encoded = JSON.stringify(detail)
  for (const field of BROWSER_FORBIDDEN_FIELDS) {
    assert.equal(encoded.includes(`"${field}"`), false, field)
  }
})

test('desktop session snapshot does not carry writer secrets', () => {
  const encoded = JSON.stringify(EMPTY_DESKTOP_SESSION)
  assert.equal(encoded.includes('writerToken'), false)
  assert.equal(encoded.includes('oneTimeToken'), false)
  assert.equal('generation' in EMPTY_DESKTOP_SESSION, true)
})
