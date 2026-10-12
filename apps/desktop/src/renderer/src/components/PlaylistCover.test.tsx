import assert from 'node:assert/strict'
import { before, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { renderedText } from '../test/renderedText'
import type { PlaylistBrowseItem } from '@shared/playlistTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: {} } })
let playlistCoverSource: typeof import('./playlistCoverSource')['playlistCoverSource']
let PlaylistCover: typeof import('./PlaylistCover')['default']
let PlaylistCard: typeof import('./PlaylistCard')['default']
let PlaylistPickerRow: typeof import('./PlaylistPickerRow')['default']
before(async () => {
  ;({ playlistCoverSource } = await import('./playlistCoverSource'))
  ;({ default: PlaylistCover } = await import('./PlaylistCover'))
  ;({ default: PlaylistCard } = await import('./PlaylistCard'))
  ;({ default: PlaylistPickerRow } = await import('./PlaylistPickerRow'))
})

function item(patch: Partial<PlaylistBrowseItem> = {}): PlaylistBrowseItem {
  return { id: 1, name: '我喜欢', description: null, cover_path: null, system_kind: 'favorites',
    preview_cover_path: 'covers/video.jpg', video_count: 3, contains_video: false, ...patch }
}

it('uses distinct bundled artwork before automatic previews but after a custom cover', () => {
  const favorite = playlistCoverSource(item(), 640)
  assert.equal(favorite.kind, 'builtin')
  assert.match(favorite.url!, /playlist-favorites\.png$/)
  const queue = playlistCoverSource(item({ system_kind: 'watch_later' }), 320)
  assert.equal(queue.kind, 'builtin')
  assert.match(queue.url!, /playlist-watch-later\.png$/)
  assert.notEqual(queue.url, favorite.url)
  const recent = playlistCoverSource({ local_kind: 'recently_played' })
  assert.equal(recent.kind, 'builtin')
  assert.match(recent.url!, /playlist-recently-played\.png$/)
  assert.deepEqual(playlistCoverSource(item({ cover_path: 'playlist_covers/custom.png' }), 640),
    { url: 'media://playlist_covers/custom.png?size=640', kind: 'custom' })
  assert.equal(playlistCoverSource(item({ cover_path: null })).url, favorite.url)
})

it('does not identify built-in lists by their names or change legacy/custom-list fallbacks', () => {
  for (const name of ['我喜欢', '收藏', '稍后观看']) {
    assert.deepEqual(playlistCoverSource(item({ name, system_kind: null }), 320),
      { url: 'media://covers/video.jpg?size=320', kind: 'automatic' })
  }
  assert.deepEqual(playlistCoverSource({ preview_cover_path: null }), { url: null, kind: 'empty' })
  assert.deepEqual(playlistCoverSource({ preview_cover_path: 'covers/legacy.jpg' }),
    { url: 'media://covers/legacy.jpg', kind: 'automatic' })
})

it('renders the same artwork in cards, details and pickers, retaining counts and click behavior', () => {
  let clicks = 0
  let tree: TestRenderer.ReactTestRenderer
  act(() => { tree = TestRenderer.create(<>
    <PlaylistCard item={item()} active={false} onOpen={() => clicks++} />
    <PlaylistCover variant="detail" playlist={item()} />
    <PlaylistPickerRow item={item()} onSelect={() => clicks++} />
  </>) })
  const images = tree!.root.findAllByType('img')
  assert.equal(images.length, 3)
  assert.ok(images.every(image => image.props.src === images[0].props.src && image.props.draggable === false))
  assert.equal(tree!.root.findAllByProps({ 'data-builtin': true }).length, 3)
  assert.match(renderedText(tree!.root.findByType(PlaylistCard)), /3 部影片/)
  act(() => tree!.root.findAllByType('button').forEach(button => button.props.onClick()))
  assert.equal(clicks, 2)
  act(() => tree!.update(<PlaylistCover variant="detail" playlist={item({ cover_path: 'playlist_covers/custom.png' })} />))
  assert.equal(tree!.root.findAllByProps({ 'data-builtin': true }).length, 0, 'custom images remain subject to privacy treatment')
  assert.equal(tree!.root.findByType('img').props.src, 'media://playlist_covers/custom.png')
  act(() => tree!.update(<PlaylistCover variant="pick" playlist={item({ system_kind: null, preview_cover_path: null })} placeholder={<span>选择清单</span>} />))
  assert.equal(tree!.root.findAllByType('img').length, 0)
  assert.equal(tree!.root.findByType('span').children[0], '选择清单')
  act(() => tree!.unmount())
})
