import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import semver from 'semver'
import { packageRelease } from './server-release-package.mjs'
import { writeUpdateBundle } from '../packages/http/src/updateBundle.ts'
import { SERVER_ENVIRONMENT_VERSION } from '../packages/contracts/src/serverUpdateTypes.ts'
import { replacementContext } from './release-replacement.mjs'

function validateVersion(version) {
  if (typeof version !== 'string' || version.length > 128 || version.includes('+') || semver.valid(version) !== version) throw new Error('Unsupported server release version')
}

/** Resolve existing ancestors so a symlink cannot put a private key in the repo. */
export function keyDirectoryOutsideRepository(directory, repository = fileURLToPath(new URL('../', import.meta.url))) {
  let ancestor = path.resolve(directory)
  const missing = []
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor))
    ancestor = path.dirname(ancestor)
  }
  const resolved = path.join(fs.realpathSync(ancestor), ...missing)
  const relative = path.relative(fs.realpathSync(repository), resolved)
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Choose a key directory outside the repository with --directory')
  return resolved
}

/** Validate before publishing images; private keys never enter an artifact. */
export function releaseSigning(version, env = process.env) {
  validateVersion(version)
  const key = env.JAVDEX_SERVER_UPDATE_SIGNING_KEY
  const keyId = env.JAVDEX_SERVER_UPDATE_KEY_ID
  if (!key || !keyId || !/^[\w-]{1,64}$/.test(keyId)) throw new Error('Configure JAVDEX_SERVER_UPDATE_SIGNING_KEY and JAVDEX_SERVER_UPDATE_KEY_ID for release signing')
  let privateKey
  try { privateKey = createPrivateKey(key) }
  catch { throw new Error('Release signing requires a valid Ed25519 private key') }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release signing requires an Ed25519 private key')
  return { keyId, privateKey, publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() }
}

/** Stable and prerelease manifests bind the same complete architecture closure. */
export function signedReleaseManifest(packaged, signer, now = Date.now()) {
  const { descriptor } = packaged
  const { version, build, targetSchema: schema, platform, runtime } = descriptor
  if (descriptor.environmentVersion !== SERVER_ENVIRONMENT_VERSION) throw new Error('Server release environment version does not match this source')
  validateVersion(version)
  if (!/^linux\/(amd64|arm64)$/.test(platform) || !Number.isSafeInteger(schema) || schema < 19) throw new Error('Invalid server release platform or schema')
  const arch = platform.split('/')[1]
  const archiveName = `Javdex-server-${version}-linux-${arch}.javdex-update`
  const manifest = {
    format: 1, version, build, expiresAt: new Date(now + 365 * 86400_000).toISOString(),
    platform, sourceSchemas: Array.from({ length: schema - 18 }, (_, i) => i + 19),
    targetSchema: schema, minUpdaterProtocol: 1, runtime, environmentVersion: SERVER_ENVIRONMENT_VERSION,
    archive: { url: `https://github.com/JavdexLabs/Javdex/releases/download/v${version}/${archiveName}`, bytes: packaged.bytes, unpackedBytes: packaged.unpackedBytes, sha256: packaged.sha256 }
  }
  const payload = JSON.stringify(manifest)
  return { keyId: signer.keyId, payload, signature: sign(null, Buffer.from(payload), signer.privateKey).toString('base64') }
}

async function main() {
  const command = process.argv[2]
  const options = new Map()
  for (let i = 3; i < process.argv.length; i += 2) {
    if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('Options require values')
    options.set(process.argv[i].slice(2), process.argv[i + 1])
  }
  if (!['keygen', 'validate', 'publish'].includes(command)) throw new Error('Use keygen, validate or publish')
  const directory = path.resolve(options.get('directory') ?? 'release-artifacts')
  if (command === 'keygen') {
    if (!options.has('directory')) throw new Error('Choose a key directory outside the repository with --directory')
    const keyDirectory = keyDirectoryOutsideRepository(directory)
    fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 })
    const keys = generateKeyPairSync('ed25519')
    fs.writeFileSync(path.join(keyDirectory, 'server-update-private.pem'), keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(path.join(keyDirectory, 'server-update-public.pem'), keys.publicKey.export({ format: 'pem', type: 'spki' }), { flag: 'wx', mode: 0o644 })
    console.log('Release key generated. Keep the private key outside the repository.')
    return
  }
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const signer = releaseSigning(version)
  if (command === 'validate') {
    console.log(`Server update signing configuration is valid for ${version}.`)
    return
  }
  const build = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const schema = Number(fs.readFileSync('packages/library/src/db/migrations.ts', 'utf8').match(/export const CURRENT_SCHEMA_VERSION = (\d+)/)?.[1])
  if (!Number.isSafeInteger(schema) || schema < 19) throw new Error('Missing supported catalog schema')
  const repository = 'ghcr.io/javdexlabs/javdex-server'
  const imageTag = process.env.RELEASE_REPLACE_090 === 'true' ? replacementContext().imageTag : version
  if (process.env.RELEASE_REPLACE_090 === 'true' && version !== '0.9.0') throw new Error('Replacement version mismatch')
  const index = JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${repository}:${imageTag}`], { encoding: 'utf8' }))
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const arch of ['amd64', 'arm64']) {
    const digest = index.manifests?.find(item => item.platform?.os === 'linux' && item.platform?.architecture === arch)?.digest
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error(`Missing verified linux/${arch} image`)
    const image = `${repository}@${digest}`
    execFileSync('docker', ['pull', '--platform', `linux/${arch}`, image], { stdio: 'inherit' })
    const archiveFile = path.join(directory, `Javdex-server-${version}-linux-${arch}.tar.gz`)
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-release-closure-'))
    const container = `javdex-release-${process.pid}-${arch}`
    let created = false
    let packaged
    try {
      execFileSync('docker', ['create', '--platform', `linux/${arch}`, '--name', container, image], { stdio: 'ignore' })
      created = true
      execFileSync('docker', ['cp', `${container}:/app/.`, staging], { stdio: 'inherit' })
      packaged = await packageRelease(staging, archiveFile, `linux/${arch}`)
      if (packaged.descriptor.version !== version || packaged.descriptor.build !== build || packaged.descriptor.targetSchema !== schema) throw new Error('Image release closure does not match this source')
      const bakedKeys = path.join(staging, 'baked-release-keys.json')
      execFileSync('docker', ['cp', `${container}:/opt/javdex-manager/release-keys.json`, bakedKeys], { stdio: 'ignore' })
      if (JSON.parse(fs.readFileSync(bakedKeys, 'utf8'))[signer.keyId] !== signer.publicKey) throw new Error('Published image does not trust this signing key')
    } finally {
      if (created) execFileSync('docker', ['rm', container], { stdio: 'ignore' })
      fs.rmSync(staging, { recursive: true, force: true })
    }
    const bundleFile = path.join(directory, `Javdex-server-${version}-linux-${arch}.javdex-update`)
    await writeUpdateBundle(archiveFile, bundleFile, signedReleaseManifest(packaged, signer))
    // The raw archive is a generated intermediate, not a public attachment.
    fs.unlinkSync(archiveFile)
  }
  const checksums = []
  for (const name of fs.readdirSync(directory).filter(name => /^Javdex-server-.*\.javdex-update$/.test(name)).sort()) {
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(path.join(directory, name))) hash.update(chunk)
    checksums.push(`${hash.digest('hex')}  ${name}`)
  }
  fs.appendFileSync(path.join(directory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) await main()
