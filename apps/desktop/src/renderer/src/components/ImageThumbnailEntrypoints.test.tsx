import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { ActressListItem } from '@shared/actressTypes'
import type { VideoAsset } from '@shared/videoTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
  api: {}, location: { href: 'http://localhost/' }, history: { state: null, pushState() {} }
}) })
let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined })

it('uses a 320 thumbnail for actress cards', async () => {
  const Card = (await import('./ActressCardTile')).default
  await act(async () => {
    renderer = TestRenderer.create(<Card actress={{ id: 1, main_name: 'Example', avatar_path: 'avatars/example.jpg', gender: 'female', video_count: 1, scraped_status: 0 } as ActressListItem}
      selected={false} selectionMode={false} onToggleSelect={() => {}} onOpen={() => {}} onDelete={() => {}} />)
  })
  assert.equal(renderer!.root.findByType('img').props.src, 'media://avatars/example.jpg?size=320')
})

for (const kind of ['video', 'actress'] as const) {
  it(`uses thumbnails for local ${kind} gallery tiles and original preview sources`, async (t) => {
    const { ImagePreviewOverlayProvider } = await import('./ImagePreviewOverlayContext')
    const sample = { id: 1, video_id: 1, actress_id: 1, type: 'sample', position: 0, local_path: 'samples/local.jpg',
      remote_url: null, width: 800, height: 600, is_primary: 0, created_at: null }
    const remote = { ...sample, id: 2, position: 1, local_path: null, remote_url: 'https://example.test/remote.jpg' }
    Object.assign(window.api, { actresses: { galleryPage: async () => ({ items: [sample, remote], total: 2, limit: 60, offset: 0 }) } })
    const VideoGallery = (await import('./VideoSampleGallery')).default
    const ActressGallery = (await import('./ActressGalleryPanel')).default
    const Lightbox = (await import('./ImagePreviewLightbox')).default
    const createElement = React.createElement
    // Keep this a parent interaction test: replace only the portal/gesture boundary.
    t.mock.method(React, 'createElement', (type: unknown, props: unknown, ...children: unknown[]) => {
      if (type === Lightbox) return createElement('div', { 'data-preview-items': (props as { items: unknown }).items })
      return Reflect.apply(createElement, React, [type, props, ...children])
    })
    await act(async () => {
      renderer = TestRenderer.create(<ImagePreviewOverlayProvider>
        {kind === 'video' ? <VideoGallery videoId={1} assets={[sample, remote] as VideoAsset[]} posterPath={null} onChanged={() => {}} />
          : <ActressGallery actressId={1} revision={{}} posterPath={null} onChanged={() => {}} />}
      </ImagePreviewOverlayProvider>)
    })
    assert.deepEqual(renderer!.root.findAllByType('img').map(image => image.props.src), [
      'media://samples/local.jpg?size=640', 'https://example.test/remote.jpg'
    ])
    await act(async () => {
      renderer!.root.findAllByType('button').find(button => button.props['aria-label'] === (kind === 'video' ? '样张 1' : '写真 1'))!.props.onClick()
    })
    const preview = renderer!.root.findAllByType('div').find(node => node.props['data-preview-items'])!
    assert.deepEqual(preview.props['data-preview-items'], [
      { id: 1, src: 'media://samples/local.jpg', localPath: 'samples/local.jpg', ...(kind === 'actress' ? { thumbnailSrc: 'media://samples/local.jpg?size=320' } : {}) },
      { id: 2, src: 'https://example.test/remote.jpg', localPath: null, ...(kind === 'actress' ? { thumbnailSrc: 'https://example.test/remote.jpg' } : {}) }
    ])
  })
}
