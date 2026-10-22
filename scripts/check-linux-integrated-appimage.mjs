#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { validatePortableRuntime } from './linux-portable-runtime.mjs'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { appImageRuntime, verifyAppImageRuntimePrefix } from './linux-appimage-runtime.mjs'
import { verifyLinuxAngleRuntime } from './linux-angle-runtime.mjs'
const require = createRequire(import.meta.url), asar = require('@electron/asar')
assert(process.argv[2], 'Pass actual integrated AppImage')
const image = path.resolve(process.argv[2]), work = mkdtempSync(path.join(tmpdir(), 'javdex-integrated-'))
const runtimeOffset = Number(execFileSync(image, ['--appimage-offset'], { encoding: 'utf8' }).trim())
assert.equal(runtimeOffset, appImageRuntime.bytes)
verifyAppImageRuntimePrefix(readFileSync(image).subarray(0, runtimeOffset))
execFileSync(image, ['--appimage-extract'], { cwd: work, maxBuffer: 32 * 1024 * 1024 })
const extracted = path.join(work, 'squashfs-root'), archive = path.join(extracted, 'resources/app.asar')
const angle = verifyLinuxAngleRuntime()
assert.deepEqual(JSON.parse(readFileSync(path.join(extracted, 'javdex-angle.json'))), angle)
for (const [file, hash] of Object.entries(angle.files)) assert.equal(playbackFileSha256(path.join(extracted, file)), hash, `Packaged ANGLE mismatch: ${file}`)
assert.equal(readFileSync(path.join(extracted, 'AppRun'), 'utf8'), readFileSync('build/linux-AppRun.sh', 'utf8'))
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).name, JSON.parse(readFileSync('package.json')).name)
// Verify the archive index too: filtering must happen before ASAR creation.
const nativeEntries = asar.listPackage(archive).map(entry => entry.replace(/^\//, ''))
for (const entry of nativeEntries) {
  const foreignSharp = /^node_modules\/@img\/(sharp-[^/]+)\/.*(?:\.node|\.so[^/]*)$/.exec(entry)
  if (foreignSharp) assert(['sharp-linux-x64', 'sharp-libvips-linux-x64'].includes(foreignSharp[1]), `Foreign Sharp binary: ${entry}`)
  const clipboard = /^node_modules\/@mariozechner\/(clipboard-[^/]+)\/.*\.node$/.exec(entry)
  if (clipboard) assert.equal(clipboard[1], 'clipboard-linux-x64-gnu', `Foreign clipboard binary: ${entry}`)
}
for (const prefix of ['@img/sharp-linux-x64/', '@img/sharp-libvips-linux-x64/', '@mariozechner/clipboard-linux-x64-gnu/']) {
  assert(nativeEntries.some(entry => entry.startsWith(`node_modules/${prefix}`) && /\.(?:node|so[^/]*)$/.test(entry)), `Missing required native package: ${prefix}`)
}
const runtimes = []
for (const [directory, target] of [['out/linux-portable-runtime/linux-x64', 'linux-texture-experimental'], ['out/linux-software-runtime/linux-x64', 'linux-software-playback']]) {
  const actual = validatePortableRuntime(path.join(extracted, 'resources', target)), expected = validatePortableRuntime(directory)
  assert.deepEqual(actual, expected, 'Packaged runtime differs from local verified input')
  const source = path.resolve(path.dirname(directory), actual.sourceBundle.filename)
  assert.equal(playbackFileSha256(source), actual.sourceBundle.sha256)
  runtimes.push({ profile: actual.profile, elfFiles: Object.keys(actual.elf).length, source })
}
function files(root) { return readdirSync(root, { withFileTypes: true }).flatMap(f => f.isDirectory() ? files(path.join(root, f.name)) : [path.join(root, f.name)]) }
let matched = 0
for (const directory of ['out/main', 'out/preload', 'out/renderer', 'out/web']) for (const file of files(directory)) {
  if (/^out\/renderer\/icon-(16|32|48|512)\.png$/.test(file)) continue // Intentional packaging exclusions.
  assert(asar.extractFile(archive, file).equals(readFileSync(file)), `Packaged code mismatch: ${file}`); matched++
}
console.log(JSON.stringify({ image, sha256: playbackFileSha256(image), extracted, matchedFiles: matched, angle, runtimes }, null, 2))
