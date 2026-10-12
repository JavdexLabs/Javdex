import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newPluginDevDraft, pluginDevDraftReducer } from './usePluginDevDraft'
import type { ScraperPluginPackage } from '@shared/scrapeTypes'

test('package changes preserve the test target; loading does not inherit a missing homepage', () => {
  const initial = { ...newPluginDevDraft(), testTarget: 'TEST-001', siteUrl: 'https://example.com' }
  const pkg: ScraperPluginPackage = { schemaVersion: 1, kind: 'video', name: 'Example', code: 'module.exports = {}' }
  const generated = pluginDevDraftReducer(initial, { type: 'generated', package: pkg })
  assert.equal(generated.siteName, 'Example')
  assert.equal(generated.testTarget, 'TEST-001')
  assert.equal(generated.siteUrl, initial.siteUrl)
  const loaded = pluginDevDraftReducer(generated, { type: 'loaded', package: pkg })
  assert.equal(loaded.siteUrl, '')
  assert.equal(loaded.testTarget, 'TEST-001')
  assert.deepEqual(pluginDevDraftReducer(loaded, { type: 'new', kind: 'actress' }), newPluginDevDraft('actress'))
})
