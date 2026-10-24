#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { playbackFileSha256, validatePackagedPlaybackRuntime, validateSignedMacPlaybackRuntime } from './playback-runtime.mjs'
import { linuxInventory, verifyLinuxSourceBundle } from './linux-release-materials.mjs'
import { verifyLinuxReleaseResources, checkLinuxPlaybackLoad } from './check-linux-release-playback.mjs'

export function verifyPackagedPlaybackResources(resources, output, target, options = {}) {
  if (existsSync(linuxInventory(resources))) {
    const runtime = verifyLinuxReleaseResources(resources, output, target)
    checkLinuxPlaybackLoad(resources)
    return runtime
  }
  const directory = path.join(resources, 'native-playback')
  assert.ok(existsSync(path.join(directory, 'runtime.json')), `Missing packaged playback runtime: ${directory}`)
  if (target.platformName === 'darwin') {
    const app = path.resolve(resources, '../..')
    const verifyAppSignature = options.verifyAppSignature ?? (app => {
      const result = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8', timeout: 60000 })
      if (result.error) throw result.error
      assert.equal(result.status, 0, 'Invalid application signature: ' + result.stderr)
    })
    verifyAppSignature(app)
  }
  const runtime = target.platformName === 'darwin'
    ? validateSignedMacPlaybackRuntime(directory, target, options)
    : validatePackagedPlaybackRuntime(directory, target, options.inspectBinary)
  const source = path.join(output, runtime.manifest.sourceBundle.fileName)
  assert.ok(existsSync(source) && lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(),
    'Missing corresponding playback source archive: ' + source)
  assert.equal(playbackFileSha256(source), runtime.manifest.sourceBundle.sha256,
    'Packaged playback source archive digest mismatch')
  return runtime
}

export function findPackagedResources(directory, depth = 0) {
  if (depth > 6 || !existsSync(directory)) return []
  if (existsSync(path.join(directory, 'app.asar'))) return [directory]
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => findPackagedResources(path.join(directory, entry.name), depth + 1))
}

async function main() {
  const output = path.resolve(process.argv[2] ?? 'dist')
  const resources = findPackagedResources(output)
  assert.ok(resources.length > 0, `No packaged application resources under ${output}`)
  const electronVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).devDependencies.electron
  for (const directory of resources) {
    if (existsSync(linuxInventory(directory))) {
      const runtime = verifyPackagedPlaybackResources(directory, output, { platformName: process.platform, archName: process.arch, electronVersion })
      await verifyLinuxSourceBundle(output, runtime.manifest)
      console.log(`Integrated Linux playback verified: ${runtime.manifest.sourceBundle.fileName}`)
      continue
    }
    const manifest = path.join(directory, 'native-playback/runtime.json')
    assert.ok(existsSync(manifest), `Missing packaged playback runtime: ${directory}`)
    const { platform, arch } = JSON.parse(readFileSync(manifest, 'utf8'))
    assert.equal(platform, process.platform, 'Packaged playback platform differs from its build host')
    const runtime = verifyPackagedPlaybackResources(directory, output, { platformName: platform, archName: arch, electronVersion })
    assert.equal(arch, process.arch, 'Playback load verification requires a native-architecture packaging runner')
    if (platform !== 'linux') {
      // The renamed, signed application is the actual DLL/entitlement host.
      // Loading only with node_modules/electron would miss that boundary.
      const executable = platform === 'darwin' ? path.resolve(directory, '../MacOS/Javdex') : path.resolve(directory, '../Javdex.exe')
      assert.ok(existsSync(executable), 'Missing packaged application executable')
      const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      for (const key of ['JAVDEX_MPV_PREFIX', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS']) delete environment[key]
      const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH'
      environment[pathKey] = platform === 'win32' ? `${process.env.SystemRoot}/System32` : '/usr/bin:/bin'
      const script = `const a=require(${JSON.stringify(path.join(runtime.directory, 'playback.node'))});const api=process.platform==='win32'?a.sharedTexture:a;for(const k of ['create','destroy','state'])if(typeof api?.[k]!=='function')throw Error('Missing native export '+k);console.log('Playback loaded by packaged application: '+process.execPath)`
      const loaded = spawnSync(executable, ['-e', script], { env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
      if (loaded.error) throw loaded.error
      assert.equal(loaded.status, 0, 'Packaged executable could not load playback: ' + loaded.stderr)
      assert.ok(loaded.stdout.includes('Playback loaded by packaged application:'), 'Packaged executable returned no playback load marker')
      console.log(loaded.stdout.trim())
    }
    const smoke = spawnSync(process.execPath, [fileURLToPath(new URL('./check-playback-load.mjs', import.meta.url)), runtime.directory], { stdio: 'inherit', timeout: 60000 })
    if (smoke.error) throw smoke.error
    assert.equal(smoke.status, 0, 'Packaged playback could not load/decode')
    console.log(`Packaged playback verified: ${platform}/${arch}, ${runtime.binaryCount} binaries, ${runtime.manifest.sourceBundle.fileName}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
