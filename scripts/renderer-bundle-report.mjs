import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

export function rendererBundleReport(manifest, measure) {
  const entry = Object.keys(manifest).find(key => manifest[key].isEntry)
  assert.ok(entry, 'Renderer manifest has no entry')
  const visited = new Set(), javascript = new Set(), css = new Set()
  const visit = key => {
    if (visited.has(key)) return
    const chunk = manifest[key]
    assert.ok(chunk, `Missing manifest dependency: ${key}`)
    visited.add(key)
    javascript.add(chunk.file)
    for (const file of chunk.css ?? []) css.add(file)
    for (const imported of chunk.imports ?? []) visit(imported)
  }
  visit(entry)
  const sum = files => [...files].reduce((result, file) => {
    const value = measure(file)
    return { bytes: result.bytes + value.bytes, gzip: result.gzip + value.gzip }
  }, { bytes: 0, gzip: 0 })
  return { initialJS: sum(javascript), initialCSS: sum(css), initialFiles: [...javascript, ...css],
    deferred: Object.entries(manifest).filter(([key, chunk]) => chunk.isDynamicEntry && !visited.has(key)).map(([key, chunk]) => ({ source: key, name: chunk.name, file: chunk.file, ...measure(chunk.file) })) }
}

export function assertDeferredRendererFeatures(report, names) {
  for (const name of names) {
    assert.ok(report.deferred.some(chunk => chunk.name === name), `${name} must remain outside the initial static closure`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve('out/renderer')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.vite/manifest.json'), 'utf8'))
  const report = rendererBundleReport(manifest, file => {
    const data = fs.readFileSync(path.join(root, file))
    return { bytes: data.length, gzip: gzipSync(data).length }
  })
  assertDeferredRendererFeatures(report, ['SettingsPage', 'PluginDevPanel', 'AppearanceSettingsPanel', 'ModelSettingsPanel', 'BackupSettingsPanel'])
  console.log(JSON.stringify(report, null, 2))
}
