import buildConfig from './electron-builder.config.mjs'
import { EXPERIMENTAL_VERSION, EXPERIMENTAL_OUTPUT, prepareExperimentalRuntime, stageExperimentalRuntime } from './scripts/wayland-experimental-package.mjs'

/** Local-only CPU/GPU testing package. All ordinary release runtime hooks still run. */
export default function experimentalConfig() {
  const config = buildConfig()
  config.appId = 'com.javdex.linux-texture-experimental'
  config.productName = 'Javdex Linux Texture Experimental'
  config.extraMetadata = { ...config.extraMetadata, name: 'javdex-linux-texture-experimental',
    version: EXPERIMENTAL_VERSION, javdexExperimentalLinux: true }
  config.directories.output = EXPERIMENTAL_OUTPUT
  config.publish = null
  config.linux.target = [{ target: 'AppImage', arch: ['x64'] }]
  config.linux.executableArgs = []
  config.linux.executableName = 'javdex-linux-texture-experimental'
  config.linux.artifactName = 'Javdex-Linux-Texture-Experimental-${version}-${arch}.${ext}'
  const before = config.beforePack, after = config.afterPack
  config.beforePack = async context => { await before(context); prepareExperimentalRuntime(context) }
  config.afterPack = async context => { await after(context); stageExperimentalRuntime(context) }
  return config
}
