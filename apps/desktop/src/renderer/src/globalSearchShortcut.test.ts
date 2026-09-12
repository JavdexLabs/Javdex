import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HOME_GLOBAL_SEARCH_ID,
  isGlobalSearchShortcut,
  queueHomeGlobalSearchFocus
} from './globalSearchShortcut'

describe('global search shortcut', () => {
  it('accepts Cmd/Ctrl+K and rejects unrelated key combinations', () => {
    assert.equal(isGlobalSearchShortcut({ metaKey: true, ctrlKey: false, key: 'k' }), true)
    assert.equal(isGlobalSearchShortcut({ metaKey: false, ctrlKey: true, key: 'K' }), true)
    assert.equal(isGlobalSearchShortcut({ metaKey: false, ctrlKey: false, key: 'k' }), false)
    assert.equal(isGlobalSearchShortcut({ metaKey: true, ctrlKey: false, key: 'p' }), false)
  })

  it('focuses and selects the Home input after two render frames', () => {
    const frames: Array<() => void> = []
    const actions: string[] = []
    queueHomeGlobalSearchFocus(
      {
        getElementById(id) {
          assert.equal(id, HOME_GLOBAL_SEARCH_ID)
          return {
            focus: () => actions.push('focus'),
            select: () => actions.push('select')
          }
        }
      },
      (callback) => frames.push(callback)
    )

    assert.deepEqual(actions, [])
    frames.shift()?.()
    assert.deepEqual(actions, [])
    frames.shift()?.()
    assert.deepEqual(actions, ['focus', 'select'])
  })
})
