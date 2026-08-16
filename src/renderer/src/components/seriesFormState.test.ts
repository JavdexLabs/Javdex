import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSeriesFormDraft, seriesInputFromDraft } from './seriesFormState'

describe('series form state', () => {
  it('defaults a rename to retaining the previous main name', () => {
    const draft = createSeriesFormDraft({
      id: 9,
      mainName: 'Before',
      imagePath: null,
      fallbackCoverPath: null,
      ownerOrganization: { id: 4, mainName: 'Owner' },
      videoCount: 0,
      updatedAt: '2026-01-01',
      aliases: ['Alias'],
      summary: null,
      parentSeries: { id: 3, mainName: 'Parent', ownerOrganization: null },
      startYear: 2000,
      endYear: null,
      status: 'ongoing',
      links: [],
      releaseYearStart: null,
      releaseYearEnd: null
    })
    assert.equal(draft.keepPreviousMainName, true)
    assert.equal(draft.ownerOrganizationId, '4')
    assert.equal(draft.parentSeriesId, '3')
  })

  it('trims text and converts optional numeric selections', () => {
    assert.deepEqual(
      seriesInputFromDraft({
        mainName: ' Series ',
        aliases: [' First ', 'Second'],
        summary: ' Summary ',
        ownerOrganizationId: '',
        parentSeriesId: '12',
        startYear: '2001',
        endYear: '',
        status: 'ongoing',
        keepPreviousMainName: true,
        links: [{ label: ' Official ', url: ' https://example.com ' }]
      }),
      {
        mainName: 'Series',
        aliases: ['First', 'Second'],
        summary: 'Summary',
        ownerOrganizationId: null,
        parentSeriesId: 12,
        startYear: 2001,
        endYear: null,
        status: 'ongoing',
        keepPreviousMainName: true,
        links: [{ label: 'Official', url: 'https://example.com' }]
      }
    )
  })
})
