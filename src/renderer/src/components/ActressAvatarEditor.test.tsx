import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createAvatarCropV1 } from '@shared/avatarCrop'

let photoTotal = 0
let photoFail = false
let photoHold: Promise<void> | null = null
const photoCalls: Array<{ id: number; offset: number; localOnly?: boolean }> = []
let coverHold: Promise<void> | null = null
let coverTotal = 0
const coverCalls: Array<{ offset?: number; withCover?: boolean }> = []

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

class TestImage {
  naturalWidth = 640
  naturalHeight = 960
  complete = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    this.complete = true
    this.onload?.()
  }
}

class TestFileReader {
  result: string | ArrayBuffer | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  readAsDataURL(): void {
    this.result = 'data:image/jpeg;base64,dGVzdA=='
    this.onload?.()
  }
}

Object.defineProperty(globalThis, 'Image', { configurable: true, value: TestImage })
Object.defineProperty(globalThis, 'FileReader', {
  configurable: true,
  value: TestFileReader
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    createElement: (tagName: string) => {
      assert.equal(tagName, 'canvas')
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toBlob: (callback: (blob: Blob | null) => void) =>
          callback(new Blob(['avatar'], { type: 'image/jpeg' }))
      }
    }
  }
})
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      actresses: { galleryPage: async (id: number, query: { offset?: number; localOnly?: boolean }) => { const offset = query.offset ?? 0; photoCalls.push({id,offset,localOnly:query.localOnly}); if(photoHold) await photoHold; if(photoFail) { photoFail=false; throw new Error('Photo page failed') } return { items: Array.from({length: Math.min(60,Math.max(0,photoTotal-offset))}, (_,n)=>({id:offset+n+1,local_path:`photo-${offset+n+1}.jpg`,remote_url:null,width:640,height:480,position:offset+n})), total:photoTotal, limit:60, offset } }, videoPage: async (_id: number, query: { offset?: number; withCover?: boolean }) => { coverCalls.push(query); if (coverHold) await coverHold; const offset = query.offset ?? 0; return { videos: Array.from({ length: Math.min(60, Math.max(0, coverTotal - offset)) }, (_, n) => ({ id: offset+n+1, code: `COVER-${offset+n+1}`, cover_path: `cover-${offset+n+1}.jpg` })), total: coverTotal, limit: 60, offset } } },
      assets: {
        getPathForFile: () => null
      }
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  assert.fail('avatar editor did not settle')
}

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  coverTotal = 0
  photoTotal = 0
  photoFail = false
  photoHold = null
  photoCalls.length = 0
  coverHold = null
  coverCalls.length = 0
})

describe('ActressAvatarEditor', () => {
  it('keeps rendering when the current avatar enters crop editing', async () => {
    const ActressAvatarEditor = (await import('./ActressAvatarEditor')).default
    const crop = createAvatarCropV1({
      sourceFingerprint: 'avatar-source',
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    })

    await act(async () => {
      renderer = TestRenderer.create(
        <ActressAvatarEditor
          displayUrl="media://avatar-display.jpg"
          sourceUrl="media://avatar-source.jpg"
          savedCrop={crop}
          actressId={1}
          onAvatarChange={() => undefined}
        />
      )
      await Promise.resolve()
    })

    const editButton = renderer!.root
      .findAllByType('button')
      .find((candidate) => nodeText(candidate) === '编辑裁剪')
    assert.ok(editButton)

    await act(async () => {
      editButton.props.onClick()
      await Promise.resolve()
    })

    assert.match(nodeText(renderer!.root), /编辑中/)
    const cropImage = renderer!.root.find(
      (node) =>
        node.type === 'img' &&
        (node.props.className === 'avatar-crop-image' ||
          node.props.className === 'avatar-crop-preview')
    )
    assert.equal(cropImage.props.crossOrigin, 'anonymous')
  })

  it('keeps rendering when a legacy avatar without its original enters crop editing', async () => {
    const ActressAvatarEditor = (await import('./ActressAvatarEditor')).default

    await act(async () => {
      renderer = TestRenderer.create(
        <ActressAvatarEditor
          displayUrl="media://legacy-avatar.jpg"
          sourceUrl={null}
          savedCrop={null}
          actressId={1}
          onAvatarChange={() => undefined}
        />
      )
      await Promise.resolve()
    })

    const editButton = renderer!.root
      .findAllByType('button')
      .find((candidate) => nodeText(candidate) === '编辑裁剪')
    assert.ok(editButton)

    await act(async () => {
      editButton.props.onClick()
      await Promise.resolve()
    })

    await waitFor(() => Boolean(renderer && nodeText(renderer.root).includes('编辑中')))
    assert.match(nodeText(renderer!.root), /编辑中/)
  })
})

it('pages associated covers without loading an actress detail or accumulating tiles', async () => {
  coverTotal = 125
  const Component = (await import('./ActressAvatarEditor')).default
  await act(async () => { renderer = TestRenderer.create(<Component actressId={1} displayUrl={null} sourceUrl={null} savedCrop={null} onAvatarChange={() => undefined} />) })
  const tiles = () => renderer!.root.findAllByType('button').filter(node => /^COVER-\d+$/.test(node.props['aria-label'] ?? ''))
  const click = async (label: string) => { await act(async () => { renderer!.root.findAllByType('button').find(node => nodeText(node) === label)!.props.onClick() }) }
  assert.equal(tiles().length, 60)
  assert.equal(new URL(tiles()[0].findByType('img').props.src).searchParams.get('size'), '320')
  assert.ok(coverCalls.every(query => query.withCover === true))
  await click('下一页')
  assert.equal(tiles().length, 60)
  assert.equal(tiles()[0].props['aria-label'], 'COVER-61')
  await click('下一页')
  assert.equal(tiles().length, 5)
  await click('上一页')
  await click('上一页')
  assert.equal(tiles()[0].props['aria-label'], 'COVER-1')
  assert.deepEqual(coverCalls.map(query => query.offset), [0,60,120,60,0])
})

it('does not replace a user-selected source tab when the first cover page arrives late', async () => {
  coverTotal = 125
  let resolve!: () => void
  coverHold = new Promise(done => { resolve = done })
  const Component = (await import('./ActressAvatarEditor')).default
  await act(async () => { renderer = TestRenderer.create(<Component actressId={1} displayUrl={null} sourceUrl={null} savedCrop={null} onAvatarChange={() => undefined} />) })
  const local = () => renderer!.root.findAllByProps({ role: 'tab' }).find(node => nodeText(node) === '本地')!
  await act(async () => local().props.onClick())
  await act(async () => resolve())
  assert.equal(local().props['aria-selected'], true)
})

it('pages photo sources with global labels and retries without fetching complete metadata', async () => {
  photoTotal = 125
  const Component = (await import('./ActressAvatarEditor')).default
  await act(async () => { renderer = TestRenderer.create(<Component actressId={7} displayUrl={null} sourceUrl={null} savedCrop={null} onAvatarChange={() => undefined} />) })
  const tiles = () => renderer!.root.findAllByType('button').filter(node => /^写真 \d+$/.test(node.props['aria-label'] ?? ''))
  const click = async (label: string) => { await act(async () => renderer!.root.findAllByType('button').find(node => nodeText(node) === label)!.props.onClick()) }
  assert.equal(tiles().length, 60)
  assert.equal(new URL(tiles()[0].findByType('img').props.src).searchParams.get('size'), '320')
  assert.equal(renderer!.root.findAllByProps({ role: 'tab' }).find(node => nodeText(node) === '写真')!.props['aria-selected'], true)
  await click('下一页')
  assert.equal(tiles()[0].props['aria-label'], '写真 61')
  photoFail = true
  await click('下一页')
  assert.ok(renderer!.root.findAllByProps({role:'alert'}).some(node => nodeText(node).includes('Photo page failed')))
  await click('重试')
  assert.equal(tiles().length, 5)
  assert.equal(tiles()[0].props['aria-label'], '写真 121')
  await click('上一页')
  await click('上一页')
  assert.equal(tiles()[0].props['aria-label'], '写真 1')
  assert.deepEqual(photoCalls.map(call => call.offset), [0,60,120,120,60,0])
  assert.ok(photoCalls.every(call => call.id === 7 && call.localOnly === true))
})

it('keeps local selection when the user opens a file picker before photos arrive', async () => {
  photoTotal = 125
  let resolve!: () => void
  photoHold = new Promise(done => { resolve = done })
  const Component = (await import('./ActressAvatarEditor')).default
  await act(async () => { renderer = TestRenderer.create(<Component actressId={1} displayUrl={null} sourceUrl={null} savedCrop={null} onAvatarChange={() => undefined} />) })
  await act(async () => renderer!.root.findAllByType('button').find(node => nodeText(node) === '选择本地图片…')!.props.onClick())
  await act(async () => resolve())
  assert.equal(renderer!.root.findAllByProps({role:'tab'}).find(node => nodeText(node) === '本地')!.props['aria-selected'], true)
})
