import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { test } from 'node:test'

const file = path.resolve('scripts/playback-acceptance-no-keychain.cjs')
const source = fs.readFileSync(file, 'utf8')
function run({ platform = 'darwin', enabled = '1', packaged = false,
  profile = path.join(os.tmpdir(), 'javdex-playback-acceptance-guard'), physical = profile } = {}) {
  let loaded = false, exit, metadata = {}, credentialReads = 0
  const safeStorage = { isEncryptionAvailable: () => { credentialReads++; return true }, encryptString: () => { credentialReads++ }, decryptString: () => { credentialReads++ } }
  const app = { isPackaged: packaged, setVersion: version => { metadata.version = version }, setName: name => { metadata.name = name }, setAppPath: root => { metadata.root = root }, exit: code => { exit = code } }
  const process = { platform, env: { JAVDEX_ACCEPTANCE_NO_KEYCHAIN: enabled, JAVDEX_TEST_USER_DATA: profile }, argv: ['electron', file, path.resolve('.'), '--javdex-cpu'] }
  vm.runInNewContext(source, { __filename: file, __dirname: path.dirname(file), process, console: { error() {} },
    require(name) {
      if (name === 'electron') return { app, safeStorage }
      if (name === 'node:fs') return { readFileSync: () => JSON.stringify({ name: 'Javdex', version: '0.9.1', main: './out/main/index.js' }), realpathSync: value => value === profile ? physical : value }
      if (name.startsWith('node:')) return globalRequire(name)
      assert.equal(name, path.resolve('out/main/index.js')); loaded = true
    } })
  return { loaded, exit, metadata, credentialReads, safeStorage, process }
}
import { createRequire } from 'node:module'
const globalRequire = createRequire(import.meta.url)

test('explicit isolated Mac acceptance skips OS credential calls and loads the real application entry', () => {
  const r = run()
  assert.equal(r.loaded, true)
  assert.equal(r.credentialReads, 0)
  assert.equal(r.safeStorage.isEncryptionAvailable(), false)
  assert.throws(() => r.safeStorage.encryptString('test-only'), /disabled/)
  assert.throws(() => r.safeStorage.decryptString(Buffer.alloc(0)), /disabled/)
  assert.equal(r.metadata.root, path.resolve('.'))
  assert.deepEqual(Array.from(r.process.argv), ['electron', path.resolve('.'), '--javdex-cpu'])
})
for (const options of [
  { enabled: '0' }, { platform: 'linux' }, { packaged: true },
  { profile: path.resolve('user-data') }, { physical: path.resolve('user-data') }
]) test(`keychain test wrapper refuses an unsafe launch: ${JSON.stringify(options)}`, () => {
  const r = run(options)
  assert.equal(r.loaded, false)
  assert.equal(r.exit, 1)
  assert.equal(r.credentialReads, 0)
})
