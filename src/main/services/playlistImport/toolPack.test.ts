import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createPlaylistImporterToolHandlers,
  PLAYLIST_IMPORTER_TOOL_PACK
} from './toolPack'

describe('PlaylistImporter ToolPack', () => {
  it('exposes static-page, virtual-window and detail checkpoints through one least-privilege pack', () => {
    assert.deepEqual(
      PLAYLIST_IMPORTER_TOOL_PACK.tools.map((tool) => tool.name),
      [
        'browser',
        'checkpoint_playlist_page',
        'advance_playlist_page',
        'report_playlist_import_failure',
        'open_playlist_item_detail',
        'checkpoint_playlist_detail'
      ]
    )
    assert.deepEqual(
      [...new Set(PLAYLIST_IMPORTER_TOOL_PACK.tools.map((tool) => tool.capability))].sort(),
      [
        'browser.read',
        'playlist-import.stage-identity',
        'playlist-import.stage-page'
      ]
    )
  })

  it('keeps state-changing navigation behind host-owned import tools', () => {
    const browser = PLAYLIST_IMPORTER_TOOL_PACK.tools.find((tool) => tool.name === 'browser')
    const browserSchema = JSON.stringify(browser?.schema)

    assert.doesNotMatch(browserSchema, /"open"/u)
    assert.doesNotMatch(browserSchema, /"click"/u)
    assert.doesNotMatch(browserSchema, /"scroll"/u)
    assert.match(browserSchema, /"snapshot"/u)
    assert.match(browserSchema, /"handoff"/u)
  })

  it('binds every declaration to a production handler', () => {
    const result = { ok: true, content: '{}', summary: 'ok' }
    const handlers = createPlaylistImporterToolHandlers({
      browser: async () => result,
      checkpointPage: async () => result,
      advancePage: async () => result,
      reportFailure: async () => result,
      openItemDetail: async () => result,
      checkpointDetail: async () => result
    })
    assert.deepEqual(
      [...handlers.keys()],
      PLAYLIST_IMPORTER_TOOL_PACK.tools.map((tool) => tool.name)
    )
  })

  it('accepts one optional page-evidenced name on the page checkpoint', () => {
    const schemas = PLAYLIST_IMPORTER_TOOL_PACK.tools
      .filter((tool) => tool.name === 'checkpoint_playlist_page')
      .map((tool) => JSON.stringify(tool.schema))

    assert.equal(schemas.length, 1)
    assert.equal(schemas.every((schema) => schema.includes('suggestedPlaylistName')), true)
    assert.equal(schemas.every((schema) => schema.includes('load-more-page-start')), true)
    assert.equal(schemas.every((schema) => schema.includes('afterExhausted')), true)
  })

  it('requires a mechanically verifiable terminal contract', () => {
    const checkpoint = PLAYLIST_IMPORTER_TOOL_PACK.tools.find(
      (tool) => tool.name === 'checkpoint_playlist_page'
    )
    const schema = JSON.stringify(checkpoint?.schema)

    assert.match(schema, /"required":\["kind","reason","selector"\]/u)
    assert.match(schema, /"known-total-reached"/u)
    assert.match(schema, /"load-more-control-exhausted"/u)
    assert.match(schema, /"required":\["kind","selector","afterExhausted"\]/u)
  })
})
