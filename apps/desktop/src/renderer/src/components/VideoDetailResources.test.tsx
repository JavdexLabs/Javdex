import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { VideoDetail, VideoResourceDetail } from '@shared/videoTypes'
import { VideoDetailSecondaryMeta } from './VideoDetailMeta'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout,
    clearTimeout
  }
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

function resource(overrides: Partial<VideoResourceDetail> = {}): VideoResourceDetail {
  return {
    id: 11,
    library_id: 1,
    video_id: 1,
    root_id: null,
    kind: 'web',
    size_bytes: null,
    duration_seconds: null,
    file_mtime_ms: null,
    display_name: null,
    strm_source_path: null,
    is_primary: 1,
    add_time: '2026-01-01T00:00:00.000Z',
    display_locator: 'example.com / resource',
    ...overrides
  }
}

function video(resources: VideoResourceDetail[]): VideoDetail {
  return {
    id: 1,
    code: 'TEST-001',
    title: null,
    original_title: null,
    summary: null,
    cover_path: null,
    poster_path: null,
    release_date: null,
    maker: null,
    publisher: null,
    maker_organization_id: null,
    publisher_organization_id: null,
    series: null,
    director: null,
    series_id: null,
    director_id: null,
    duration_seconds: null,
    resolved_duration_seconds: null,
    scraped_status: 0,
    last_scraped_at: null,
    updated_at: null,
    add_time: '2026-01-01T00:00:00.000Z',
    rating: 0,
    actresses: [],
    tags: [],
    resources,
    assets: [],
    external_stats: [],
    links: []
  }
}

function renderResources(
  resources: VideoResourceDetail[],
  onMoveResource?: (resource: VideoResourceDetail) => void
): void {
  act(() => {
    renderer = TestRenderer.create(
      <VideoDetailSecondaryMeta
        video={video(resources)}
        onMoveResource={onMoveResource}
        onAddResource={() => undefined}
      />
    )
  })
}

function actionLabels(): string[] {
  return (
    renderer?.root
      .findAllByType('button')
      .map((button) => button.props['aria-label'])
      .filter((label): label is string => typeof label === 'string') ?? []
  )
}

describe('video detail resource actions', () => {
  it('shows copy and external-open actions instead of play for link resources', () => {
    renderResources([resource()])

    const labels = actionLabels()
    assert.ok(labels.includes('复制链接'))
    assert.ok(labels.includes('打开网页链接'))
    assert.ok(!labels.some((label) => label.includes('播放')))

    const copyButton = renderer?.root.findByProps({ 'aria-label': '复制链接' })
    const openButton = renderer?.root.findByProps({ 'aria-label': '打开网页链接' })
    assert.match(String(copyButton?.findByType('svg').props.className), /lucide-copy/)
    assert.match(String(openButton?.findByType('svg').props.className), /lucide-external-link/)
  })

  it('keeps the play action for local resources', () => {
    renderResources([
      resource({
        kind: 'local',
        display_locator: 'D:\\Videos\\TEST-001.mp4',
        display_name: 'TEST-001.mp4'
      })
    ])

    assert.ok(actionLabels().includes('播放此文件'))
  })

  it('shows actual link kind, STRM hosting, masked target, and source path together', () => {
    renderResources([
      resource({
        kind: 'direct',
        display_name: 'CDN 版本',
        display_locator: 'cdn.example / TEST-001.mp4',
        strm_source_path: '/library/TEST-001.strm'
      })
    ])

    const output = JSON.stringify(renderer?.toJSON())
    assert.match(output, /视频直链/)
    assert.match(output, /STRM 托管/)
    assert.match(output, /cdn\.example \/ TEST-001\.mp4/)
    assert.match(output, /\/library\/TEST-001\.strm/)

    act(() => {
      renderer?.root.findByProps({ 'aria-label': '更多' }).props.onClick()
    })
    const menu = JSON.stringify(renderer?.toJSON())
    assert.match(menu, /在文件夹中显示/)
    assert.match(menu, /删除 STRM 源文件/)
    assert.doesNotMatch(menu, /编辑 STRM 文本|打开 STRM 文本/)
  })

  it('exposes the cross-library move command for both links and root-managed resources', () => {
    const moved: VideoResourceDetail[] = []
    const target = resource()
    renderResources([target], (selected) => moved.push(selected))

    act(() => {
      renderer?.root.findByProps({ 'aria-label': '更多' }).props.onClick()
    })
    const linkMove = renderer?.root
      .findAllByType('button')
      .find((button) => button.children.join('') === '移动到其它媒体库')
    assert.ok(linkMove)
    act(() => linkMove.props.onClick())
    assert.deepEqual(moved, [target])

    const local = resource({ kind: 'local', display_locator: '/library/TEST-001.mp4' })
    renderResources([local], (selected) => moved.push(selected))
    act(() => {
      renderer?.root.findByProps({ 'aria-label': '更多' }).props.onClick()
    })
    const localMove = renderer?.root
      .findAllByType('button')
      .find((button) => button.children.join('') === '移动到其它媒体库')
    assert.ok(localMove, 'local resources keep an explicit command that can explain root migration')
    act(() => localMove.props.onClick())
    assert.equal(moved.at(-1), local)
  })
})
