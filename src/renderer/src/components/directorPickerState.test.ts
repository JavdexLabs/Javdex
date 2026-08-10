import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  directorOptionDescription,
  selectedDirectorAssignment,
  typedDirectorAssignment
} from './directorPickerState'

describe('director picker state', () => {
  it('keeps typed same-name input as an explicit inline-create request', () => {
    assert.deepEqual(typedDirectorAssignment(' Alex Lee '), {
      createName: 'Alex Lee',
    })
    assert.equal(typedDirectorAssignment('  '), null)
  })

  it('shows stable candidate differences rather than silently choosing by name', () => {
    const first = {
      id: 9,
      mainName: 'Alex Lee',
      aliases: ['A. Lee'],
      countryRegion: 'US',
      birthDate: '1970-01-02',
      careerStartYear: 1990,
      careerEndYear: null,
      videoCount: 12
    }
    const second = { ...first, id: 10 }
    assert.equal(
      directorOptionDescription(first),
      '#9 · US · 出生 1970-01-02 · 从业 1990-至今 · 别名 A. Lee · 12 部'
    )
    assert.notEqual(directorOptionDescription(first), directorOptionDescription(second))
    assert.deepEqual(selectedDirectorAssignment(first), { directorId: 9 })
    assert.deepEqual(typedDirectorAssignment(first.mainName), { createName: 'Alex Lee' })
    assert.equal(typedDirectorAssignment(''), null)
  })
})
