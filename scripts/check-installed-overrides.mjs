import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const product = read(path.join(root, 'package.json'))
const lock = read(path.join(root, 'package-lock.json'))
const name = '@earendil-works/pi-coding-agent'
const pinned = product.overrides[name]
// npm 10 reimports the upstream shrinkwrap during ci when this flag is present,
// silently replacing our security overrides even though npm audit reads our lock.
assert.ok(!lock.packages[`node_modules/${name}`].hasShrinkwrap, 'Pi shrinkwrap must not override the product lockfile')
const require = createRequire(path.join(root, 'package.json'))
function installedManifest(loader, dependency) {
  // Inspect metadata without executing ESM-only dependencies or relying on a
  // package.json subpath export; use the owning package's Node lookup paths.
  for (const directory of loader.resolve.paths(dependency) ?? []) {
    const file = path.join(directory, dependency, 'package.json')
    if (existsSync(file)) return file
  }
  throw new Error(`Missing installed manifest for ${dependency}`)
}
const agentRequire = createRequire(installedManifest(require, name))
const minimatchRequire = createRequire(installedManifest(agentRequire, 'minimatch'))
for (const [loader, dependency, expected] of [
  [agentRequire, 'undici', pinned.undici],
  [minimatchRequire, 'brace-expansion', pinned.minimatch['brace-expansion']]
]) {
  assert.equal(read(installedManifest(loader, dependency)).version, expected,
    `Installed Pi ${dependency} differs from the security override`)
}
console.log('Installed Pi security overrides match the product lockfile.')
