import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOrganizationAssignment, organizationOptionDescription } from './organizationPickerState'

const options = [
  { id: 1, mainName: 'Studio One', aliases: ['Ｓ １'], roles: ['maker'] as const },
  { id: 2, mainName: 'Publisher Two', aliases: [], roles: ['publisher'] as const }
]

describe('organization picker state', () => {
  it('resolves main names and aliases to stable ids', () => {
    assert.deepEqual(resolveOrganizationAssignment(' studio one ', options), {
      organizationId: 1
    })
    assert.deepEqual(resolveOrganizationAssignment('ｓ　１', options), {
      organizationId: 1
    })
  })

  it('uses unmatched text as an explicit inline create request', () => {
    assert.deepEqual(resolveOrganizationAssignment(' New Studio ', options), {
      createName: 'New Studio'
    })
  })

  it('uses an empty value to remove the organization relation', () => {
    assert.equal(resolveOrganizationAssignment('  ', options), null)
  })

  it('describes candidates by stable id, roles, and aliases', () => {
    assert.equal(organizationOptionDescription(options[0]), '#1 · 制作商 · 别名 Ｓ １')
    assert.equal(organizationOptionDescription(options[1]), '#2 · 发行商')
  })
})
