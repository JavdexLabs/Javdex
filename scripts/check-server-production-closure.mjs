import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const workspace = JSON.parse(fs.readFileSync('apps/server/package.json', 'utf8'))
assert.equal(workspace.version, root.version)
assert.equal(workspace.license, root.license)
assert.equal(workspace.dependencies['better-sqlite3'], root.dependencies['better-sqlite3'])
assert.equal(workspace.dependencies.sharp, root.dependencies.sharp)
for (const forbidden of ['electron', 'playwright', 'playwright-core', '@earendil-works/pi-coding-agent']) {
  assert.equal(workspace.dependencies[forbidden], undefined, `server workspace must not depend on ${forbidden}`)
}

const productionPath = 'out/server/package.json'
if (fs.existsSync(productionPath)) {
  const production = JSON.parse(fs.readFileSync(productionPath, 'utf8'))
  assert.equal(production.license, root.license, 'server production license must match the project license')
  for (const file of ['LICENSE', 'NOTICE', 'LICENSES/Javdex-MIT.txt', 'LICENSES/node-gyp-MIT.txt', 'docs/THIRD_PARTY_NOTICES.md']) {
    assert.equal(
      fs.readFileSync(path.join('out/server', file), 'utf8'),
      fs.readFileSync(file, 'utf8'),
      `server production must retain ${file}`
    )
  }
  assert.deepEqual(Object.keys(production.dependencies).sort(), ['better-sqlite3', 'sharp'])
  assert.equal(production.dependencies['better-sqlite3'], root.dependencies['better-sqlite3'])
  assert.equal(production.dependencies.sharp, root.dependencies.sharp)
  const files = fs.readdirSync('out/server')
  assert.ok(files.includes('index.js'))
  assert.ok(files.includes('webCatalogWorker.js'))
  assert.equal(files.includes('electron'), false)
}

console.log('Server production dependency closure is valid.')
