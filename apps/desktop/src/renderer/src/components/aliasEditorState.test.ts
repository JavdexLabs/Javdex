import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promoteAliasToMain } from './aliasEditorState'

describe('alias editor state', () => {
  it('promotes an alias to main name and keeps the previous main as an alias', () => {
    assert.deepEqual(promoteAliasToMain('Director', ['Alias A', 'Alias B'], 'Alias B'), {
      mainName: 'Alias B',
      aliases: ['Alias A', 'Director']
    })
  })

  it('does not duplicate the previous main name when it is already an alias', () => {
    assert.deepEqual(promoteAliasToMain('Director', ['Director', 'Alias B'], 'Alias B'), {
      mainName: 'Alias B',
      aliases: ['Director']
    })
  })
})
