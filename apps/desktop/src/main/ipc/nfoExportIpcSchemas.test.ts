import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IPC } from '@shared/ipc-channels'
import { nfoExportIpcSchemas } from './nfoExportIpcSchemas'

describe('NFO export IPC schemas', () => {
  it('accepts the complete closed plan request and rejects missing or extra state', () => {
    const valid = [{
      libraryIds: [1, 2],
      profileId: 'portable-v1',
      includeCover: true,
      includeFanart: true,
      includeSamples: false,
      includeActorAvatars: false,
      collisionPolicy: 'skip'
    }]
    assert.equal(nfoExportIpcSchemas[IPC.NFO_EXPORT_PLAN].safeParse(valid).success, true)
    assert.equal(nfoExportIpcSchemas[IPC.NFO_EXPORT_PLAN].safeParse([
      { ...valid[0], collisionPolicy: 'replace', manifestPath: '/tmp/export.json' }
    ]).success, false)
    assert.equal(nfoExportIpcSchemas[IPC.NFO_EXPORT_PLAN].safeParse([
      { ...valid[0], collisionPolicy: undefined }
    ]).success, false)
  })
})
