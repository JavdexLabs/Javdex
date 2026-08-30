import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createAvatarCropV1 } from '@shared/avatarCrop'

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
          videos={[]}
          gallery={[]}
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
          videos={[]}
          gallery={[]}
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
