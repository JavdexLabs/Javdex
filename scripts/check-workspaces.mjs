import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isBuiltin } from 'node:module'
import { importsOf, sourceFiles } from './lib/import-boundary-check.mjs'

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const workspaces = ['apps/desktop', 'apps/web', 'apps/server', 'packages/contracts', 'packages/ui', 'packages/library', 'packages/http']
for (const directory of workspaces) {
  const manifest = JSON.parse(fs.readFileSync(`${directory}/package.json`, 'utf8'))
  assert.equal(manifest.version, root.version, `${directory}: version must match the product version`)
  assert.equal(manifest.private, true, `${directory}: internal workspace must be private`)
}
assert.equal(root.scripts.postinstall, undefined, 'Root install must not rebuild Electron native modules')
const violations = []
for (const directory of ['apps/web/src', 'packages/contracts/src', 'packages/ui/src']) {
  for (const file of sourceFiles(directory)) {
    if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
    for (const specifier of importsOf(file)) {
      const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier).replaceAll('\\', '/') : specifier
      const forbidden = /(?:^|\/)apps\/desktop\//.test(resolved)
        || /(?:^|\/)packages\/(?:library|http)\//.test(resolved)
        || isBuiltin(specifier)
        || /^(?:@library|@renderer)\//.test(specifier)
        || /^(?:electron(?:\/|$)|node:|better-sqlite3(?:\/|$)|sharp(?:\/|$)|playwright(?:-core)?(?:\/|$)|@javdex\/(?:desktop|server|library|http)(?:\/|$))/.test(specifier)
      if (forbidden) violations.push(`${file}: browser/shared code imports ${specifier}`)
    }
  }
}
assert.equal(violations.length, 0, violations.join('\n'))
console.log('Workspace versions and browser/shared dependency boundaries passed.')
console.log('library currently owns catalog db, image store, scan helpers, and local root file guard; scanner orchestration/NFO/services remain in desktop. server/http are reserved. This check does not claim a runnable server.')
