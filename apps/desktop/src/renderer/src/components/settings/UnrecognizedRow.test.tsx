import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
const renameCalls: unknown[][] = []
const importCalls: unknown[][] = []
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      scan: {
        rename: async (...args: unknown[]) => {
          renameCalls.push(args)
          return {
            newPath: 'D:/media/LOMD-007.mp4',
            newName: 'LOMD-007.mp4',
            code: null,
            imported: false,
            outcome: 'unrecognized'
          }
        },
        importManual: async (...args: unknown[]) => {
          importCalls.push(args)
          return { imported: true, code: 'RBD-677' }
        }
      },
      videos: { list: async () => ({ items: [] }) }
    },
    setTimeout,
    clearTimeout
  }
})
let renderer: TestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  renderer?.unmount()
  renderer = null
  renameCalls.length = 0
  importCalls.length = 0
})

it('defaults the import target to a new video so typing a code is enough to import', async () => {
  const { default: UnrecognizedRow } = await import('./UnrecognizedRow')
  const refreshed: string[] = []
  await act(async () => {
    renderer = TestRenderer.create(
      <UnrecognizedRow
        libraryId={1}
        rootId={2}
        path="D:/media/RBD677.mp4"
        onResolved={(oldPath) => refreshed.push(oldPath)}
      />
    )
  })
  const importButton = () =>
    renderer!.root.findAllByType('button').find((button) => visibleText(button) === '导入')!
  assert.equal(importButton().props.disabled, true)
  act(() => {
    renderer!.root
      .findByProps({ 'aria-label': 'RBD677.mp4 番号' })
      .props.onChange({ target: { value: 'RBD-677' } })
  })
  assert.equal(
    renderer!.root.findByProps({ 'aria-label': 'RBD677.mp4 导入目标' }).props.value,
    'new'
  )
  assert.equal(importButton().props.disabled, false)
  await act(async () => {
    await importButton().props.onClick()
  })
  assert.deepEqual(importCalls, [[1, 2, 'D:/media/RBD677.mp4', 'RBD-677', { kind: 'new' }]])
  assert.deepEqual(refreshed, ['D:/media/RBD677.mp4'])
})

it('renames with no manual code or target and refreshes the pending row after failed recognition', async () => {
  const { default: UnrecognizedRow } = await import('./UnrecognizedRow')
  const refreshed: string[] = []
  await act(async () => {
    renderer = TestRenderer.create(
      <UnrecognizedRow
        libraryId={1}
        rootId={2}
        path="D:/media/LOMD007.mp4"
        onResolved={(oldPath) => refreshed.push(oldPath)}
      />
    )
  })
  const action = () =>
    renderer!.root.findAllByType('button').find((button) => visibleText(button) === '重命名并导入')!
  assert.equal(action().props.disabled, true)
  act(() => {
    renderer!.root
      .findByProps({ 'aria-label': 'LOMD007.mp4 新文件名' })
      .props.onChange({ target: { value: 'LOMD-007' } })
  })
  assert.equal(renderer!.root.findByProps({ 'aria-label': 'LOMD007.mp4 番号' }).props.value, '')
  assert.equal(action().props.disabled, false)
  await act(async () => {
    await action().props.onClick()
  })
  assert.deepEqual(renameCalls, [[1, 2, 'D:/media/LOMD007.mp4', 'LOMD-007']])
  assert.deepEqual(refreshed, ['D:/media/LOMD007.mp4'])
})

function visibleText(node: TestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(child => visibleText(child as TestRenderer.ReactTestInstance)).join('')
}
