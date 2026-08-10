import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDirectorFormDraft, directorInputFromDraft } from './directorFormState'

describe('director form state', () => {
  it('defaults to preserving a changed main name and converts profile fields', () => {
    const draft = createDirectorFormDraft()
    assert.equal(draft.keepPreviousMainName, true)
    assert.deepEqual(
      directorInputFromDraft({
        ...draft,
        mainName: ' Director ',
        aliases: 'Alias A\nAlias B',
        careerStartYear: '1999',
        birthDate: '1970-01-01',
        links: [{ label: 'Site', url: 'https://example.com' }],
      }),
      {
        mainName: 'Director',
        aliases: ['Alias A', 'Alias B'],
        keepPreviousMainName: true,
        summary: null,
        countryRegion: null,
        birthDate: '1970-01-01',
        deathDate: null,
        birthPlace: null,
        careerStartYear: 1999,
        careerEndYear: null,
        status: 'unknown',
        links: [{ label: 'Site', url: 'https://example.com' }],
      },
    )
  })
})
