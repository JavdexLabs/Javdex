import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertDeferredRendererFeatures, rendererBundleReport } from './renderer-bundle-report.mjs'

test('measures the deduplicated static closure, not just the entry filename or all deferred chunks', () => {
  const manifest = { root: { isEntry: true, file: 'root.js', imports: ['shared'], dynamicImports: ['feature'], css: ['root.css', 'shared.css'] },
    shared: { file: 'shared.js', css: ['shared.css'] }, feature: { isDynamicEntry: true, file: 'feature.js', imports: ['shared'] } }
  const report = rendererBundleReport(manifest, () => ({ bytes: 100, gzip: 25 }))
  assert.deepEqual(report.initialJS, { bytes: 200, gzip: 50 })
  assert.deepEqual(report.initialCSS, { bytes: 200, gzip: 50 })
  assert.equal(report.deferred[0].file, 'feature.js')
  assert.throws(() => rendererBundleReport({ root: { isEntry: true, file: 'x.js', imports: ['missing'] } }, () => ({})), /Missing manifest dependency/)
})

test('recognizes source-less dynamic chunks by manifest name and rejects eager imports', () => {
  const manifest = { root: { isEntry: true, file: 'root.js', dynamicImports: ['_SettingsPage-hash.js'] },
    '_SettingsPage-hash.js': { name: 'SettingsPage', isDynamicEntry: true, file: 'settings.js', imports: ['root'] } }
  const measure = () => ({ bytes: 10, gzip: 5 })
  assertDeferredRendererFeatures(rendererBundleReport(manifest, measure), ['SettingsPage'])
  manifest.root.imports = ['_SettingsPage-hash.js']
  assert.throws(() => assertDeferredRendererFeatures(rendererBundleReport(manifest, measure), ['SettingsPage']), /outside the initial static closure/)
})
