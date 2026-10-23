import fs from 'node:fs'
import path from 'node:path'
import { c as createTar } from 'tar'
import { createLinuxSourceBundle, linuxPackagingFiles, linuxReleaseComponents } from '../linux-release-materials.mjs'
import { playbackFileSha256 as hash } from '../playback-runtime.mjs'

export const write = (root, name, bytes) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  fs.writeFileSync(path.join(root, name), typeof bytes === 'object' && !Buffer.isBuffer(bytes) ? JSON.stringify(bytes) : bytes)
}
export async function linuxReleaseFixture(root, version = JSON.parse(fs.readFileSync('package.json')).version) {
  const project = path.join(root, 'project'), app = path.join(root, 'app'), output = path.join(root, 'release')
  for (const name of linuxPackagingFiles(process.cwd())) write(project, name, fs.readFileSync(name))
  write(project, 'package.json', { ...JSON.parse(fs.readFileSync(path.join(project, 'package.json'))), version })
  const sdk = { electronVersion: 'fixture', nodeVersion: '1.2.3' }
  const upstream = path.join(root, 'preferred-source')
  write(upstream, 'nv_codec_headers.tar.gz', 'preferred NVDEC'); write(upstream, 'mpv.tar.gz', 'preferred mpv'); write(upstream, 'ffmpeg.tar.xz', 'preferred ffmpeg')
  const sources = ['mpv', 'ffmpeg', 'nv_codec_headers'].map(id => {
    const filename = id === 'ffmpeg' ? 'ffmpeg.tar.xz' : id + '.tar.gz'
    return { id, version: 'fixture', filename, bytes: fs.statSync(path.join(upstream, filename)).size, sha256: hash(path.join(upstream, filename)) }
  })
  write(project, 'build/playback-sources.json', { sdk, sources })
  const angleLock = JSON.parse(fs.readFileSync(path.join(project, 'build/angle-runtime.json')))
  const inventories = {}, archives = {}, inputs = {}
  for (const id of ['gpu', 'cpu', 'angle']) {
    const input = path.join(root, 'input-' + id), directory = path.join(app, linuxReleaseComponents[id].directory)
    fs.mkdirSync(input); fs.mkdirSync(directory, { recursive: true }); inputs[id] = input
    if (id === 'angle') {
      for (const name of ['build/angle-runtime.json', 'build/angle-args.gn', 'scripts/build-linux-angle.py', 'build/patches/angle-x11-vulkan-visual.patch',
        ...Object.keys(angleLock.electronPatches).map(n => 'build/angle-electron-patches/' + n)]) write(input, 'recipe/' + name, fs.readFileSync(path.join(project, name)))
      for (const name of ['angle/LICENSE', 'angle/DEPS', 'angle/include/EGL/egl.h', 'angle/src/libANGLE/renderer/vulkan/linux/xcb/DisplayVkXcb.cpp']) write(input, name, 'preferred ' + name)
      write(directory, 'libEGL.so', 'EGL'); write(directory, 'libGLESv2.so', 'GLES'); write(directory, 'ANGLE-LICENSE.txt', fs.readFileSync(path.join(input, 'angle/LICENSE')))
      inventories[id] = { schemaVersion: 1, electronVersion: sdk.electronVersion, angleRevision: angleLock.angleRevision,
        patchSha256: hash(path.join(project, 'build/patches/angle-x11-vulkan-visual.patch')), argsSha256: hash(path.join(project, 'build/angle-args.gn')),
        provenanceSha256: hash(path.join(project, 'build/angle-runtime.json')),
        files: Object.fromEntries(['libEGL.so', 'libGLESv2.so'].map(n => [n, hash(path.join(directory, n))])) }
    } else {
      const receipt = { profile: linuxReleaseComponents[id].profile, sdk, sources: sources.filter(s => id !== 'cpu' || s.id !== 'nv_codec_headers'), sourcePackages: { fixture: '1.0' } }
      write(directory, 'build.json', receipt)
      for (const name of ['libmpv.so.2', 'playback-fd.node', id === 'gpu' ? 'playback-dmabuf-helper' : 'playback-software-helper']) write(directory, name, id + ' ' + name)
      const files = Object.fromEntries(fs.readdirSync(directory).map(name => [name, hash(path.join(directory, name))]))
      inventories[id] = { schemaVersion: 1, profile: receipt.profile, electronVersion: sdk.electronVersion, files }
      fs.cpSync(directory, path.join(input, 'runtime'), { recursive: true })
      for (const name of linuxPackagingFiles(project)) write(input, 'recipe/' + name, fs.readFileSync(path.join(project, name)))
      write(input, 'recipe/.javdex-source-files.json', linuxPackagingFiles(project))
      for (const pin of sources) write(input, pin.filename, fs.readFileSync(path.join(upstream, pin.filename)))
      write(input, 'fixture.tar.xz', 'Ubuntu preferred source')
      write(input, 'fixture.dsc', `Format: 3.0 (native)\nSource: fixture\nVersion: 1.0\nChecksums-Sha256:\n ${hash(path.join(input, 'fixture.tar.xz'))} ${fs.statSync(path.join(input, 'fixture.tar.xz')).size} fixture.tar.xz\n`)
      write(input, 'electron-sdk/include/node/node_version.h', '#define NODE_MAJOR_VERSION 1\n#define NODE_MINOR_VERSION 2\n#define NODE_PATCH_VERSION 3\n')
      write(input, 'electron-sdk/include/node/node.h', 'Node SDK')
    }
    const archive = path.join(root, id + '.tar.gz')
    await createTar({ cwd: input, file: archive, gzip: true }, ['.'])
    archives[id] = archive
    inventories[id].sourceBundle = { filename: path.basename(archive), sha256: hash(archive) }
    write(directory, linuxReleaseComponents[id].manifest, inventories[id])
  }
  write(app, 'AppRun', 'launcher'); write(app, 'resources/appimage-runtime.json', { runtime: 'fixture' })
  write(app, 'resources/app.asar', 'application')
  const rebuild = () => createLinuxSourceBundle(app, output, project, inventories, archives, version)
  return { project, app, output, inventories, archives, inputs, version, rebuild, manifest: rebuild() }
}
