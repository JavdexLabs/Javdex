import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VideoDetail, VideoExternalStats } from '@shared/videoTypes'
import VideoDetailRatings from './VideoDetailRatings'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

const rating = (source: string, is_default: number, fetched_at: string): VideoExternalStats => ({
  id: is_default + 1, video_id: 1, source, is_default, fetched_at, rating_average: 4, rating_count: 10
})
const render = (external_stats: VideoExternalStats[]): string => renderToStaticMarkup(
  <VideoDetailRatings video={{ rating: 0, external_stats } as VideoDetail} onRatingChange={() => {}} />
)

it('shows only the selected external rating without a default label', () => {
  const markup = render([rating('Older selection', 1, '2024-01-01'), rating('Newer source', 0, '2025-01-01')])
  assert.match(markup, /Older selection/)
  assert.doesNotMatch(markup, /Newer source|默认/)
})

it('falls back to the newest valid score and hides the group when no scores remain', () => {
  const markup = render([rating('Older', 0, '2024-01-01'), rating('Newer', 0, '2025-01-01')])
  assert.match(markup, /Newer/)
  assert.doesNotMatch(markup, /Older/)
  assert.doesNotMatch(render([]), /外部评分/)
  assert.doesNotMatch(render([{ ...rating('Empty', 1, ''), rating_average: null }]), /外部评分/)
})
