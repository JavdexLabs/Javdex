// Explicit local development packaging; audited release inventories stay separate.
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { electronBuilderArchName } from './packaging-runtime.mjs'
import { inspectWindowsPlaybackBinary } from './playback-runtime.mjs'

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')

export function verifyLocalPlaybackRuntime(context, { environment = process.env } = {}) {
  const source = environment.JAVDEX_LOCAL_PLAYBACK_DIR
  if (source === undefined) return null
  assert.ok(typeof source === 'string' && source.trim(), 'Local playback directory must not be empty')
  assert.equal(environment.JAVDEX_PLAYBACK_RUNTIME_DIR, undefined, 'Local playback and reviewed release runtimes are mutually exclusive')
  assert.equal(context.electronPlatformName, 'win32', 'Local playback packaging currently supports Windows only')
  assert.ok(existsSync(source) && lstatSync(source).isDirectory() && !lstatSync(source).isSymbolicLink(), 'Local playback build is missing; run playback:native:build first')
  const directory = realpathSync(source)
  const addon = path.join(directory, 'playback.node')
  assert.ok(existsSync(addon), 'Local playback addon is missing; run playback:native:build first')
  const candidates = [addon, ...readdirSync(directory)
    .filter(name => /\.dll$/i.test(name) && name.toLowerCase() !== 'opengl32.dll')
    .map(name => path.join(directory, name))]
  const byName = new Map(candidates.map(file => [path.basename(file).toLowerCase(), file]))
  assert.equal(byName.size, candidates.length, 'Ambiguous local playback DLL names')
  const archName = electronBuilderArchName(context.arch)
  const selected = new Set()
  const queue = [addon]
  while (queue.length) {
    const file = queue.shift()
    if (selected.has(file)) continue
    assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Local playback files must be regular files')
    const imports = inspectWindowsPlaybackBinary(file, { directory, archName, binaryFiles: candidates })
    selected.add(file)
    for (const name of [...imports.dependencies, ...imports.delayedDependencies]) {
      if (byName.has(name)) queue.push(byName.get(name))
    }
  }
  return { directory, archName, electronVersion: context.packager.info.framework.version,
    files: Object.fromEntries([...selected].map(file => [path.basename(file), digest(file)])) }
}

export function stageLocalPlaybackRuntime(context, options) {
  const input = verifyLocalPlaybackRuntime(context, options)
  if (!input) return null
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), 'native-playback')
  assert.ok(!existsSync(destination), 'Refusing to overwrite a packaged playback runtime')
  mkdirSync(destination, { recursive: true })
  for (const [name, expected] of Object.entries(input.files)) {
    const file = path.join(destination, name)
    copyFileSync(path.join(input.directory, name), file)
    assert.equal(digest(file), expected, 'Local playback changed during packaging: ' + name)
  }
  const manifest = { purpose: 'local-development', platform: 'win32', arch: input.archName,
    electronVersion: input.electronVersion, files: input.files }
  writeFileSync(path.join(destination, 'local-runtime.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(path.join(destination, 'LOCAL-DEVELOPMENT.txt'),
    'Local development playback build. This is not an audited release runtime. Public distributions require JAVDEX_PLAYBACK_RUNTIME_DIR and its corresponding source materials.\n')
  console.log(`Staged local development playback: win32/${input.archName}, ${Object.keys(input.files).length} binaries`)
  return { directory: destination, manifest }
}
