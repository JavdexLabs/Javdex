// Linux x64 media runtimes remain private to their respective helper processes.
import assert from 'node:assert/strict'
import { verifyLinuxAngleRuntime, stageLinuxAngleRuntime } from './linux-angle-runtime.mjs'
import { cpSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { validatePortableRuntime } from './linux-portable-runtime.mjs'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { createLinuxSourceBundle } from './linux-release-materials.mjs'
export function integratedLinuxPlayback(context) {
  return context.electronPlatformName === 'linux' && context.arch === 1
    && context.packager?.config?.extraMetadata?.javdexExperimentalLinux !== true
}
const runtimes = [['out/linux-portable-runtime/linux-x64', 'linux-texture-experimental'], ['out/linux-software-runtime/linux-x64', 'linux-software-playback']]
export function verifyIntegratedLinuxPlayback() {
  verifyLinuxAngleRuntime()
  for (const [directory] of runtimes) {
    const manifest = validatePortableRuntime(directory)
    assert.equal(manifest.electronVersion, JSON.parse(readFileSync('node_modules/electron/package.json')).version)
    assert.equal(path.basename(manifest.sourceBundle.filename), manifest.sourceBundle.filename, 'Portable source archive must be a sibling')
    assert.equal(playbackFileSha256(path.join(path.dirname(directory), manifest.sourceBundle.filename)), manifest.sourceBundle.sha256, 'Corresponding source archive mismatch')
  }
}
export function stageIntegratedLinuxPlayback(context) {
  verifyIntegratedLinuxPlayback()
  stageLinuxAngleRuntime(context)
  for (const [directory, target] of runtimes) cpSync(directory, path.join(context.appOutDir, 'resources', target), { recursive: true })
  cpSync('build/linux-AppRun.sh', path.join(context.appOutDir, 'AppRun'))
  cpSync('out/linux-appimage-tools/uruntime-0.8.1/runtime.json', path.join(context.appOutDir, 'resources/appimage-runtime.json'))
  const inventories = { angle: verifyLinuxAngleRuntime() }, sources = {
    angle: path.join('out/linux-angle-runtime', inventories.angle.sourceBundle.filename)
  }
  for (const [index, [directory]] of runtimes.entries()) {
    const id = index === 0 ? 'gpu' : 'cpu'
    inventories[id] = validatePortableRuntime(directory)
    sources[id] = path.join(path.dirname(directory), inventories[id].sourceBundle.filename)
  }
  createLinuxSourceBundle(context.appOutDir, path.resolve(context.packager.info.outDir ?? path.dirname(context.appOutDir)),
    process.cwd(), inventories, sources, context.packager.appInfo.version)
}
