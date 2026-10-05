import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInteractionLayers } from './interactionLayers'

function escape(extra = {}) {
  return Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', ...extra }) as KeyboardEvent
}

test('ownership beats child-before-parent registration, Escape dismisses only the top layer', () => {
  const stack = createInteractionLayers()
  const calls: string[] = []
  const removeChild = stack.register({ id: 'select', parentId: 'dialog', root: () => null, dismiss: () => calls.push('select') })
  const removeParent = stack.register({ id: 'dialog', modal: true, root: () => null, dismiss: () => calls.push('dialog') })
  stack.handleKey(escape())
  assert.deepEqual(calls, ['select'])
  assert.equal(stack.isTop('dialog'), false)
  assert.equal(stack.isActiveModal('dialog'), true, 'a child select owns keys, while its dialog remains the active modal')
  const removeNested = stack.register({ id: 'nested', parentId: 'dialog', modal: true, root: () => null })
  assert.equal(stack.isActiveModal('dialog'), false)
  assert.equal(stack.isActiveModal('nested'), true)
  removeNested()
  assert.equal(stack.isActiveModal('dialog'), true)
  removeChild()
  stack.handleKey(escape())
  assert.deepEqual(calls, ['select', 'dialog'])
  removeParent()
  assert.equal(stack.hasModal(), false)
})

test('composition and handled keys are ignored; a non-dismissible top layer still consumes Escape', () => {
  const stack = createInteractionLayers()
  let dismissed = 0
  stack.register({ id: 'dialog', root: () => null, dismiss: () => dismissed++ })
  const handled = escape(); handled.preventDefault()
  for (const event of [handled, escape({ isComposing: true }), escape({ keyCode: 229 })]) stack.handleKey(event)
  assert.equal(dismissed, 0)
  stack.register({ id: 'task', root: () => null })
  const blocked = escape(); stack.handleKey(blocked)
  assert.equal(blocked.defaultPrevented, true)
  assert.equal(dismissed, 0)
})

test('task shortcut policy remains active through an owned detail layer but not unrelated layers', () => {
  const stack = createInteractionLayers()
  const calls: string[] = []
  stack.register({ id: 'task', root: () => null, modal: true, blockShortcut: event => event.ctrlKey && event.key === 'r' })
  const removeDetail = stack.register({ id: 'detail', parentId: 'task', root: () => null, modal: true, dismiss: () => calls.push('detail') })
  const refresh = escape({ key: 'r', ctrlKey: true })
  assert.equal(stack.blocksShortcut(refresh), true)
  stack.handleKey(refresh)
  assert.equal(refresh.defaultPrevented, true)
  stack.handleKey(escape())
  assert.deepEqual(calls, ['detail'], 'Escape still belongs to the detail')
  removeDetail()
  assert.equal(stack.blocksShortcut(escape({ key: 'r', ctrlKey: true })), true)
  stack.register({ id: 'unrelated', root: () => null })
  assert.equal(stack.blocksShortcut(escape({ key: 'r', ctrlKey: true })), false)
})
