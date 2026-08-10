import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOrganizationFormDraft,
  moveOrganizationLink,
  organizationUpdateInputFromDraft,
  retainSelectedParentOption
} from './organizationFormState'

describe('organization form state', () => {
  it('defaults to preserving the previous main name while retaining ordered aliases and links', () => {
    const draft = createOrganizationFormDraft({
      id: 7,
      mainName: 'Current',
      aliases: ['Alias B', 'Alias A'],
      imagePath: null,
      fallbackCoverPath: null,
      videoCount: 0,
      updatedAt: '2025-01-01',
      summary: null,
      countryRegion: null,
      foundedYear: null,
      endedYear: null,
      status: 'unknown',
      parent: null,
      links: [
        { label: 'Second', url: 'https://example.com/2', position: 0 },
        { label: 'First', url: 'https://example.com/1', position: 1 }
      ],
      roles: ['maker'],
      releaseYearStart: null,
      releaseYearEnd: null
    })

    assert.equal(draft.keepPreviousMainName, true)
    assert.deepEqual(organizationUpdateInputFromDraft({ ...draft, mainName: 'Next' }), {
      mainName: 'Next',
      keepPreviousMainName: true,
      aliases: ['Alias B', 'Alias A'],
      summary: null,
      countryRegion: null,
      foundedYear: null,
      endedYear: null,
      status: 'unknown',
      parentOrganizationId: null,
      links: [
        { label: 'Second', url: 'https://example.com/2' },
        { label: 'First', url: 'https://example.com/1' }
      ]
    })
  })

  it('moves links without mutating the current form state', () => {
    const links = [
      { label: 'Official', url: 'https://example.com' },
      { label: 'Wiki', url: 'https://example.com/wiki' }
    ]

    assert.deepEqual(moveOrganizationLink(links, 1, 0), [links[1], links[0]])
    assert.deepEqual(links.map((link) => link.label), ['Official', 'Wiki'])
    assert.deepEqual(moveOrganizationLink(links, 0, -1), links)
  })

  it('retains a selected parent while search results change', () => {
    const selected = { id: 300, mainName: 'Selected Parent' }
    const results = [
      { id: 12, mainName: 'Search Result', aliases: [], roles: ['maker' as const] },
      { id: 7, mainName: 'Current Organization', aliases: [], roles: ['publisher' as const] }
    ]

    assert.deepEqual(retainSelectedParentOption(results, selected, 7), [
      { ...selected, aliases: [], roles: [] },
      results[0]
    ])
    assert.deepEqual(retainSelectedParentOption(results, results[0], 7), [results[0]])
  })
})
