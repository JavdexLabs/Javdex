import path from 'node:path'
import { importsOf, sourceFiles } from './lib/import-boundary-check.mjs'

function importsMetadataSources(specifier) {
  return specifier === 'metadata-sources' || specifier.includes('metadata-sources')
}

function importsMetadataSourcePrivateFile(specifier) {
  return /metadata-sources\//.test(specifier)
}

const metadataRoot = path.resolve('apps/desktop/src/main/metadata-sources')
const privateImplementationCallers = new Set([
  path.resolve('apps/desktop/src/main/scrapers/scraperManager.ts')
])
const violations = []

for (const file of ['apps', 'packages'].flatMap(sourceFiles)) {
  const resolved = path.resolve(file)
  const insideMetadataSources =
    resolved === metadataRoot || resolved.startsWith(`${metadataRoot}${path.sep}`)
  if (insideMetadataSources) continue

  for (const specifier of importsOf(file)) {
    if (!importsMetadataSources(specifier)) continue
    if (resolved.includes(`${path.sep}renderer${path.sep}`) || resolved.includes(`${path.sep}shared${path.sep}`)) {
      violations.push(
        `${file.replaceAll('\\', '/')}: renderer/shared code cannot import main-process metadata sources`
      )
      continue
    }
    if (resolved.includes(`${path.sep}bundled-plugins${path.sep}`)) {
      violations.push(
        `${file.replaceAll('\\', '/')}: ordinary scraper plugins cannot import host metadata sources`
      )
      continue
    }
    if (importsMetadataSourcePrivateFile(specifier) && !privateImplementationCallers.has(resolved)) {
      violations.push(
        `${file.replaceAll('\\', '/')}: import the metadata-sources public index instead of ${specifier}`
      )
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('Video metadata source boundaries are valid.')
