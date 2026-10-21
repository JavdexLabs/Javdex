import assert from 'node:assert/strict'
import { cpSync, readFileSync } from 'node:fs'
import path from 'node:path'
import buildConfig from './electron-builder.config.mjs'
import { prunePackagedRuntime } from './scripts/packaging-runtime.mjs'
import { validatePortableRuntime } from './scripts/linux-portable-runtime.mjs'
import { playbackFileSha256 } from './scripts/playback-runtime.mjs'

// Separate local-only phase-1 contract; override the integrated runtime hooks.
export default function portableConfig() {
  const config = buildConfig()
  const runtime = path.resolve('out/linux-portable-runtime/linux-x64')
  const verify = () => {
    const manifest = validatePortableRuntime(runtime)
    assert.equal(manifest.electronVersion, JSON.parse(readFileSync('node_modules/electron/package.json')).version)
    assert.equal(playbackFileSha256(path.join(path.dirname(runtime), manifest.sourceBundle.filename)), manifest.sourceBundle.sha256, 'Portable corresponding source archive mismatch')
  }
  config.appId = 'com.javdex.linux-portable-phase1'
  config.productName = 'Javdex Linux Portable Phase1'
  config.extraMetadata = { ...config.extraMetadata, name: 'javdex-linux-portable-phase1', version: '0.9.1-linux-portable.1', javdexExperimentalLinux: true }
  config.directories.output = 'dist/linux-portable-phase1'
  config.publish = null
  config.npmRebuild = false // existing verified N-API production modules; no ABI-specific addon rebuild
  config.linux.target = [{ target: 'AppImage', arch: ['x64'] }]
  config.linux.executableArgs = []
  config.linux.executableName = 'javdex-linux-portable-phase1'
  config.linux.artifactName = 'Javdex-Linux-Portable-Phase1-${version}-${arch}.${ext}'
  config.beforePack = verify
  config.afterPack = async context => {
    await prunePackagedRuntime(context)
    verify()
    cpSync(runtime, path.join(context.appOutDir, 'resources/linux-texture-experimental'), { recursive: true })
    cpSync('build/linux-portable-AppRun.sh', path.join(context.appOutDir, 'AppRun'))
  }
  config.afterSign = undefined
  return config
}
