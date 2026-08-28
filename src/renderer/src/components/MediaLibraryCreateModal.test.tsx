import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer'
import type {
  CreateMediaLibraryInput,
  MediaLibraryDetail
} from '@shared/mediaLibraryTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let createInput: CreateMediaLibraryInput | null = null
let createFailure: Error | null = null
let renderer: TestRenderer.ReactTestRenderer | null = null

const createdLibrary = {
  id: 8,
  name: 'NAS 收藏',
  activeRootCount: 2
} as MediaLibraryDetail

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      mediaLibraries: {
        create: async (input: CreateMediaLibraryInput) => {
          createInput = input
          if (createFailure) throw createFailure
          return createdLibrary
        }
      },
      scrape: {
        listPlugins: async () => ['JavDB'],
        listPluginDetails: async () => []
      },
      settings: {
        get: async () => ({ defaultScraper: 'JavDB' }),
        pickFolder: async () => ['/media/a', '/media/a', '/media/b']
      }
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback: () => void) {
      callback()
      return 1
    },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout
  }
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { activeElement: null, body: { style: { overflow: '' } } }
})

function renderedText(): string {
  type RenderNode = string | ReactTestRendererJSON | RenderNode[] | null
  const collect = (node: RenderNode): string => {
    if (node == null) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(collect).join('')
    return node.children?.map(collect).join('') ?? ''
  }
  return collect(renderer?.toJSON() ?? null)
}

function button(label: string): TestRenderer.ReactTestInstance {
  assert.ok(renderer)
  const match = renderer.root.findAllByType('button').find((candidate) => {
    const text = candidate.findAll(() => true).flatMap((node) => node.children).join('')
    return text.includes(label)
  })
  assert.ok(match, `missing button ${label}`)
  return match
}

function submitStep(): void {
  assert.ok(renderer)
  renderer.root.findByProps({ id: 'media-library-create-step-form' }).props.onSubmit({
    preventDefault() {}
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  createInput = null
  createFailure = null
})

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('MediaLibraryCreateModal', () => {
  it('validates in place and exposes a keyboard-submit four-step flow', async () => {
    const { default: MediaLibraryCreateModal } = await import('./MediaLibraryCreateModal')
    act(() => {
      renderer = TestRenderer.create(
        <MediaLibraryCreateModal onCancel={() => {}} onCreated={() => {}} />
      )
    })
    assert.ok(renderer)

    assert.equal(
      renderer.root.findByProps({ 'aria-current': 'step' }).props['aria-label'],
      '第 1 步：基本信息'
    )
    assert.equal(button('下一步').props.type, 'submit')
    assert.equal(button('下一步').props.form, 'media-library-create-step-form')

    act(() => submitStep())
    assert.match(renderedText(), /请输入媒体库名称后再继续/)
    assert.equal(
      renderer.root.findByProps({ placeholder: '例如：本地影片、NAS 收藏' }).props[
        'aria-invalid'
      ],
      true
    )

    act(() => {
      renderer?.root
        .findByProps({ placeholder: '例如：本地影片、NAS 收藏' })
        .props.onChange({ target: { value: 'NAS 收藏' } })
    })
    act(() => submitStep())
    assert.match(renderedText(), /来源目录（可选）/)

    act(() => submitStep())
    assert.match(renderedText(), /扫描行为/)
    const interval = renderer.root.findByProps({ min: 5, max: 10_080 })
    act(() => interval.props.onChange({ target: { value: '1' } }))
    act(() => submitStep())
    assert.match(renderedText(), /自动扫描周期必须为 5 到 10080 分钟/)
    assert.equal(interval.props['aria-invalid'], true)

    act(() => interval.props.onChange({ target: { value: '60' } }))
    act(() => submitStep())
    assert.match(renderedText(), /创建后立即扫描/)
    assert.match(renderedText(), /暂不添加/)
    assert.equal(
      renderer.root.findByProps({ 'aria-label': '创建后立即扫描' }).props.disabled,
      true
    )

    act(() => button('上一步').props.onClick())
    assert.match(renderedText(), /扫描行为/)
    const visitedFinalStep = renderer.root.findByProps({ 'aria-label': '第 4 步：首次扫描' })
    assert.equal(visitedFinalStep.props.disabled, false)
    act(() => visitedFinalStep.props.onClick())
    assert.match(renderedText(), /创建后立即扫描/)

    await settle()
  })

  it('deduplicates selected roots, submits independent config, and returns root errors to their step', async () => {
    const { default: MediaLibraryCreateModal } = await import('./MediaLibraryCreateModal')
    let createdScanAfterCreate: boolean | null = null
    act(() => {
      renderer = TestRenderer.create(
        <MediaLibraryCreateModal
          onCancel={() => {}}
          onCreated={(_library, scanAfterCreate) => {
            createdScanAfterCreate = scanAfterCreate
          }}
        />
      )
    })
    assert.ok(renderer)

    act(() => {
      renderer?.root
        .findByProps({ placeholder: '例如：本地影片、NAS 收藏' })
        .props.onChange({ target: { value: ' NAS 收藏 ' } })
    })
    act(() => submitStep())
    await act(async () => {
      button('选择目录').props.onClick()
      await Promise.resolve()
    })
    assert.equal(renderer.root.findAllByProps({ title: '/media/a' }).length, 1)
    assert.equal(renderer.root.findAllByProps({ title: '/media/b' }).length, 1)

    act(() => submitStep())
    act(() => submitStep())
    const firstScan = renderer.root.findByProps({ 'aria-label': '创建后立即扫描' })
    assert.equal(firstScan.props.disabled, false)
    act(() => firstScan.props.onChange({ target: { checked: true } }))

    createFailure = new Error('根目录与另一个媒体库的来源路径重叠。')
    await act(async () => {
      submitStep()
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.match(renderedText(), /来源路径重叠/)
    assert.equal(
      renderer.root.findByProps({ 'aria-current': 'step' }).props['aria-label'],
      '第 2 步：根目录'
    )

    createFailure = null
    act(() => renderer?.root.findByProps({ 'aria-label': '第 4 步：首次扫描' }).props.onClick())
    await act(async () => {
      submitStep()
      await Promise.resolve()
      await Promise.resolve()
    })

    assert.equal(createInput?.name, 'NAS 收藏')
    assert.deepEqual(createInput?.roots, [
      { path: '/media/a', state: 'active' },
      { path: '/media/b', state: 'active' }
    ])
    assert.equal(createInput?.config?.autoScanIntervalMinutes, 1440)
    assert.equal(createdScanAfterCreate, true)
  })
})
