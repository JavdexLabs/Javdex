// Test-only main wrapper. Run the real application entry with unavailable OS
// credentials, only in an unpackaged Mac acceptance process and scratch profile.
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { app, safeStorage } = require('electron')

try {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.env.JAVDEX_ACCEPTANCE_NO_KEYCHAIN, '1')
  assert.equal(app.isPackaged, false, 'keychain bypass cannot run in a packaged application')
  const profile = fs.realpathSync(path.resolve(process.env.JAVDEX_TEST_USER_DATA || '.'))
  const relative = path.relative(fs.realpathSync(os.tmpdir()), profile)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && path.basename(profile).startsWith('javdex-playback-acceptance-'), 'keychain bypass requires an owned scratch acceptance profile')
  const root = path.resolve(__dirname, '..'), entry = process.argv.indexOf(__filename)
  assert.ok(entry >= 1 && process.argv[entry + 1] === root, 'acceptance wrapper requires the repository entry')
  safeStorage.isEncryptionAvailable = () => false
  safeStorage.encryptString = safeStorage.decryptString = () => { throw new Error('OS credentials disabled in isolated playback acceptance') }
  // Match Electron default_app's package metadata setup before loading the same
  // compiled application. No production credential implementation is replaced.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  app.setVersion(pkg.version)
  app.setName(pkg.productName || pkg.name)
  app.setAppPath(root)
  process.argv.splice(entry, 2, root)
  require(path.resolve(root, pkg.main))
} catch (error) {
  console.error('[playback-acceptance-no-keychain]', error)
  app.exit(1)
}
