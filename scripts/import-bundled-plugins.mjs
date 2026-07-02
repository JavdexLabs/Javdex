import fs from 'node:fs'
import path from 'node:path'

const srcDir = process.argv[2] ?? 'D:/Desktop/内置插件'
const outDir = path.resolve('src/main/bundled-plugins')

function sanitizeFileName(input) {
  const cleaned = input.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_')
  return cleaned.slice(0, 80) || 'scraper_plugin'
}

if (!fs.existsSync(srcDir)) {
  console.error(`Source directory not found: ${srcDir}`)
  process.exit(1)
}

for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith('.avscraper.json')) continue
  const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, file), 'utf-8'))
  const dir = path.join(outDir, pkg.kind, sanitizeFileName(pkg.name))
  fs.mkdirSync(dir, { recursive: true })
  const manifest = {
    schemaVersion: 1,
    kind: pkg.kind,
    name: pkg.name,
    version: pkg.version?.trim() || '1.0.0',
    description: pkg.description?.trim() || '',
    author: pkg.author?.trim() || undefined,
    homepage: pkg.homepage?.trim() || undefined,
    supportedFields: pkg.supportedFields ?? [],
    entry: 'index.cjs'
  }
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  fs.writeFileSync(path.join(dir, manifest.entry), pkg.code, 'utf-8')
  console.log(`wrote ${dir}`)
}
