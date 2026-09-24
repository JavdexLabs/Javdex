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


it('bounds pending scrape pages and details at the IPC boundary', () => {
  const schema = scrapeIpcSchemas[IPC.PENDING_VIDEO_SCRAPE_PAGE]
  for (const query of [{}, {limit:100,offset:500}, {videoId:100}, {anchorId:2}]) assert.equal(schema.safeParse([query]).success,true)
  for (const query of [{limit:101},{offset:-1},{anchorId:1,videoId:2},{videoId:Number.MAX_SAFE_INTEGER+1},{sql:'SELECT 1'}]) assert.equal(schema.safeParse([query]).success,false)
  assert.equal(scrapeIpcSchemas[IPC.PENDING_VIDEO_SCRAPE_GET].safeParse([0]).success,false)
})


it('bounds audit pending presence lookups', () => {
  const schema=scrapeIpcSchemas[IPC.PENDING_VIDEO_SCRAPE_EXISTING_IDS]
  assert.equal(schema.safeParse([[]]).success,true)
  assert.equal(schema.safeParse([Array.from({length:100},(_,i)=>i+1)]).success,true)
  for(const ids of [[0],[-1],[1.5],[Number.MAX_SAFE_INTEGER+1],Array(101).fill(1)]) assert.equal(schema.safeParse([ids]).success,false)
})


it('validates token and safe nonnegative avatar snapshot cursor', () => {
  const schema=scrapeIpcSchemas[IPC.AVATAR_AUTO_CROP_BATCH_TARGETS]
  assert.equal(schema.safeParse(['token',0]).success,true)
  for(const args of [['',0],['token',-1],['token',1.5],['token',Infinity],['token',Number.MAX_SAFE_INTEGER+1],['token'],['token',0,1]])assert.equal(schema.safeParse(args).success,false)
})
