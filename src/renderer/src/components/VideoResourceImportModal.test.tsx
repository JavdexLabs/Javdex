import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { VideoResource } from '@shared/videoTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: { videos: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout,
    clearTimeout
  }
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { activeElement: null, body: { style: { overflow: '' } } }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

function strmResource(): VideoResource {
  return {
    id: 2,
    video_id: 1,
    kind: 'direct',
    locator: 'https://cdn.example/TEST-001.mp4?token=secret',
    resource_key: 'strm:/library/TEST-001.strm',
    strm_source_path: '/library/TEST-001.strm',
    size_bytes: 1024,
    duration_seconds: null,
    file_mtime_ms: null,
    display_name: '测试资源',
    is_primary: 1,
    add_time: '2026-01-01T00:00:00.000Z'
  }
}

describe('VideoResourceImportModal', () => {
  it('keeps a STRM target read-only while allowing metadata edits and HTTP checks', async () => {
    const { default: VideoResourceImportModal } = await import('./VideoResourceImportModal')
    act(() => {
      renderer = TestRenderer.create(
        <VideoResourceImportModal
          fixedCode="TEST-001"
          resource={strmResource()}
          onCancel={() => undefined}
        />
      )
    })
    const mounted = renderer!

    assert.equal(mounted.root.findByProps({ id: 'resource-url' }).props.disabled, true)
    assert.equal(mounted.root.findByProps({ id: 'resource-kind' }).props.disabled, true)
    assert.equal(mounted.root.findByProps({ id: 'resource-name' }).props.disabled, false)
    assert.equal(mounted.root.findByProps({ id: 'resource-size' }).props.disabled, false)
    assert.ok(
      mounted.root
        .findAllByType('button')
        .some((button) => button.children.includes('检测链接'))
    )
    assert.match(JSON.stringify(mounted.toJSON()), /请修改源文件内容并重新扫描/)
  })
})
