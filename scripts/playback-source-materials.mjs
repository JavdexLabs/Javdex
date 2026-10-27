import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const playbackPackagingFiles = ['scripts/playback-runtime.mjs', 'scripts/playback-source-materials.mjs',
  'scripts/packaging-runtime.mjs', 'scripts/local-playback-package.mjs', 'scripts/windows-angle-runtime.mjs',
  'build/windows-angle-runtime.json', 'scripts/packaged-asar.mjs', 'scripts/dist.mjs', 'electron-builder.config.mjs',
  'build/packaging.targets.json', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE']
export function playbackPackagingDigest(directory, names = playbackPackagingFiles) {
  const hash = createHash('sha256')
  for (const name of names) hash.update(name + '\0').update(readFileSync(path.join(directory, name)))
  return hash.digest('hex')
}
export function playbackInstallers(version) {
  return {
    [`Javdex-Setup-${version}-x64.exe`]: 'windows-x64', [`Javdex-Setup-${version}-x64.zip`]: 'windows-x64',
    [`Javdex-${version}-x64.dmg`]: 'macos-x64', [`Javdex-${version}-arm64.dmg`]: 'macos-arm64',
    [`Javdex-${version}-amd64.deb`]: 'linux-x64', [`Javdex-${version}-x86_64.AppImage`]: 'linux-x64'
  }
}
