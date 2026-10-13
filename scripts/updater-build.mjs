import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { createPublicKey } from 'node:crypto'

const output = path.resolve('out/updater')
fs.mkdirSync(output, { recursive: true })
await build({
  entryPoints: ['apps/server/src/updater/index.ts'], outfile: path.join(output, 'index.js'),
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  alias: { '@shared': path.resolve('packages/contracts/src') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
})
// The image receives a standalone JS publisher, not source TS or npm tooling.
await build({ entryPoints: ['scripts/server-release-package.mjs'], outfile: path.join(output, 'package.mjs'), bundle: true,
  platform: 'node', target: 'node22', format: 'esm',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
const product = JSON.parse(fs.readFileSync('package.json', 'utf8'))
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'javdex-server-updater', version: product.version, type: 'module', private: true, license: product.license }))
for (const file of ['LICENSE', 'NOTICE', 'LICENSES']) fs.cpSync(file, path.join(output, file), { recursive: true })
for (const [name, license] of [['semver', 'LICENSE'], ['tar', 'LICENSE.md'], ['zod', 'LICENSE']]) {
  fs.copyFileSync(path.resolve('node_modules', name, license), path.join(output, 'LICENSES', `${name}-license.txt`))
}
const keys = {}
if (process.env.JAVDEX_SERVER_UPDATE_SIGNING_KEY) {
  const id = process.env.JAVDEX_SERVER_UPDATE_KEY_ID
  if (!id || !/^[\w-]{1,64}$/.test(id)) throw new Error('Missing release signing key ID')
  const publicKey = createPublicKey(process.env.JAVDEX_SERVER_UPDATE_SIGNING_KEY)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Release signing requires Ed25519')
  keys[id] = publicKey.export({ type: 'spki', format: 'pem' }).toString()
}
fs.writeFileSync(path.join(output, 'release-keys.json'), `${JSON.stringify(keys)}\n`)
console.log('Container management entry written to out/updater; no signing secrets are included.')
