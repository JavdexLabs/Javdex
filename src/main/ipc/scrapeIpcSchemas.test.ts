import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IPC } from '@shared/ipc-channels'
import { scrapeIpcSchemas } from './ipcCommandSchemas'

describe('scrape IPC schemas', () => {
  it('strictly validates media-library-scoped video batch scrape commands', () => {
    const countSchema = scrapeIpcSchemas[IPC.SCRAPE_VIDEO_BATCH_COUNT]
    const startSchema = scrapeIpcSchemas[IPC.SCRAPE_VIDEO_BATCH_START]

    assert.equal(
      countSchema.safeParse([{ libraryId: 2, status: 0, missingFields: ['summary'] }]).success,
      true
    )
    assert.equal(
      startSchema.safeParse([
        { libraryId: 2, status: 'all', videoIds: [7], fields: ['title'], mode: 'fillEmpty' }
      ]).success,
      true
    )
    assert.equal(countSchema.safeParse([{ libraryId: 0, status: 'all' }]).success, false)
    assert.equal(countSchema.safeParse([{ libraryId: 2, status: 'unknown' }]).success, false)
    assert.equal(
      startSchema.safeParse([
        { libraryId: 2, status: 'all', fields: ['not-a-field'], unexpected: true }
      ]).success,
      false
    )
  })

  it('validates the optional media-library scope on single-video scrape commands', () => {
    const schema = scrapeIpcSchemas[IPC.SCRAPE_ONE]

    assert.equal(schema.safeParse([7]).success, true)
    assert.equal(
      schema.safeParse([7, 'Test', ['title'], 'fillEmpty', undefined, 2]).success,
      true
    )
    assert.equal(
      schema.safeParse([7, 'Test', ['title'], 'fillEmpty', undefined, 0]).success,
      false
    )
  })
})
