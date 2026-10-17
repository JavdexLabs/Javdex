import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const execute = promisify(execFile)
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tools = JSON.parse(await fs.readFile(new URL('./windows-vulkan-build-tools.json', import.meta.url), 'utf8'))
const source = JSON.parse(await fs.readFile(new URL('./ai-runtime-sources.json', import.meta.url), 'utf8')).whisper
export const windowsVulkanBundleVersion = 'whisper-b5130-vulkan-v1'
const fingerprint = createHash('sha256').update(JSON.stringify([source, tools])).update(windowsVulkanCommands.toString()).update(extractWindowsVulkanTool.toString()).digest('hex')
const hashFile = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex') }
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: 'inherit' })
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)))
})
export function windowsVulkanCommands(sourceRoot, build, sdk, generator) {
  return [
    ['-S', sourceRoot, '-B', build, '-G', generator, '-A', 'x64', '-DGGML_VULKAN=ON', '-DGGML_CUDA=OFF', '-DBUILD_SHARED_LIBS=OFF',
      '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF', '-DWHISPER_CURL=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF',
      '-DGGML_AVX=OFF', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_F16C=OFF', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
      `-DCMAKE_PREFIX_PATH=${sdk}`,
      `-DVulkan_INCLUDE_DIR=${path.join(sdk, 'include')}`, `-DVulkan_LIBRARY=${path.join(sdk, 'vulkan-1.lib')}`, `-DVulkan_GLSLC_EXECUTABLE=${path.join(sdk, 'bin/glslc.exe')}`],
    ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j', '6']
  ]
}
export async function extractWindowsVulkanTool(archive, directory, root, execute = run) {
  // Windows tar may delegate .zst to an external filter which exits 70 when tar
  // closes its output pipe at the end marker before all zero padding is written.
  // Decode the complete pinned input first; never ignore a decompressor error.
  assert.equal(typeof zlib.zstdDecompressSync, 'function', 'Windows Vulkan builds require Node.js 22.15 or newer')
  const bytes = await fs.readFile(archive)
  assert.ok(bytes.length <= 64 * 1024 ** 2, 'Vulkan build input exceeds size limit')
  const tar = zlib.zstdDecompressSync(bytes, { maxOutputLength: 512 * 1024 ** 2 })
  const decoded = `${archive}.decoded-${randomUUID()}.tar`
  await fs.writeFile(decoded, tar, { flag: 'wx' })
  try { await execute('tar.exe', ['-xf', decoded, '-C', directory], root) }
  finally { await fs.rm(decoded) }
}
export async function refreshWindowsVulkanInventory(directory, metadata = {}) {
  const filesRoot = path.join(directory, 'whisper')
  const files = await Promise.all((await fs.readdir(filesRoot)).map(async name => ({ name, bytes: (await fs.stat(path.join(filesRoot, name))).size, sha256: await hashFile(path.join(filesRoot, name)) })))
  const manifest = { ...metadata, version: windowsVulkanBundleVersion, target: 'win32-x64-vulkan', fingerprint, source, buildTools: tools, assets: { whisper: { files } } }
  await fs.writeFile(path.join(directory, 'bundle.json'), JSON.stringify(manifest, null, 2))
  return manifest
}
export async function verifyWindowsVulkanBundle(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'bundle.json'), 'utf8'))
  assert.equal(manifest.version, windowsVulkanBundleVersion); assert.equal(manifest.target, 'win32-x64-vulkan'); assert.equal(manifest.fingerprint, fingerprint)
  assert.ok(Array.isArray(manifest.assets?.whisper?.files) && manifest.assets.whisper.files.length < 100)
  const names = new Set()
  for (const file of manifest.assets.whisper.files) {
    assert.ok(typeof file.name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file.name) && !names.has(file.name.toLowerCase()))
    names.add(file.name.toLowerCase())
    const filename = path.join(directory, 'whisper', file.name), stat = await fs.lstat(filename)
    assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.size, file.bytes); assert.equal(await hashFile(filename), file.sha256)
  }
  assert.ok(names.has('whisper-cli.exe') && names.has('vulkan-1.dll') && names.has('license-whisper.txt') && names.has('license-vulkan-loader.txt'))
  assert.equal((await fs.readdir(path.join(directory, 'whisper'))).length, names.size, 'Unlisted Vulkan runtime files')
  return manifest
}
async function downloadPinned(asset, cache, base) {
  const filename = path.join(cache, asset.filename)
  if (await hashFile(filename).catch(() => '') === asset.sha256) return filename
  const url = asset.url ?? `${base}/${encodeURIComponent(asset.filename)}`
  console.log('Pinned AI build input:', asset.filename)
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  assert.ok(response.ok && response.body, `Cannot download ${asset.filename}`)
  const file = await fs.open(filename, 'w'), hash = createHash('sha256')
  let bytes = 0
  try { for await (const chunk of response.body) { bytes += chunk.length; assert.ok(bytes <= 64 * 1024 ** 2); hash.update(chunk); await file.write(chunk) } }
  finally { await file.close() }
  assert.equal(hash.digest('hex'), asset.sha256, `Invalid pinned AI build input: ${asset.filename}`)
  return filename
}
export async function buildWindowsVulkanRuntime(root = project) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
  const destination = path.join(root, 'out/ai-runtime/win32-x64-vulkan')
  try { await verifyWindowsVulkanBundle(destination); return destination } catch { /* Build missing or stale bundle. */ }
  const buildRoot = path.join(root, 'out/ai-runtime-build/windows-vulkan-tools'), cache = path.join(buildRoot, 'sources')
  await fs.mkdir(cache, { recursive: true })
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  const installations = JSON.parse((await execute(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'])).stdout)
  assert.ok(installations.length, 'Windows Vulkan build needs Visual Studio C++ tools')
  const installation = installations[0], vs = installation.installationPath
  const cmake = path.join(vs, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe')
  const versions = (await fs.readdir(path.join(vs, 'VC/Tools/MSVC'))).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  const msvc = path.join(vs, 'VC/Tools/MSVC', versions[0], 'bin/Hostx64/x64')
  // ggml's nested ExternalProject MSBuild paths exceed MAX_PATH inside deep checkouts.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'jv-'))
  const sdkRoot = path.join(buildRoot, 'sdk'); await fs.mkdir(sdkRoot, { recursive: true })
  const base = process.env.JAVDEX_AI_BUILD_MIRROR ?? 'https://mirror.msys2.org/mingw/ucrt64'
  assert.equal(new URL(base).protocol, 'https:')
  for (const tool of tools) {
    const archive = await downloadPinned(tool, cache, base)
    await extractWindowsVulkanTool(archive, sdkRoot, root)
  }
  const sdk = path.join(sdkRoot, 'ucrt64'), sourceTar = await downloadPinned(source, cache)
  await run('tar.exe', ['-xf', sourceTar, '--strip-components=1', '-C', work], root)
  const exports = (await execute(path.join(msvc, 'dumpbin.exe'), ['/exports', path.join(sdk, 'bin/vulkan-1.dll')])).stdout
  const names = [...exports.matchAll(/^\s+\d+\s+[0-9a-f]+\s+[0-9a-f]+\s+(vk\w+)/gmi)].map(match => match[1])
  assert.ok(names.length > 10)
  const definition = path.join(sdk, 'vulkan.def')
  await fs.writeFile(definition, `LIBRARY vulkan-1.dll\nEXPORTS\n${names.join('\n')}\n`)
  await run(path.join(msvc, 'lib.exe'), ['/nologo', '/machine:x64', `/def:${definition}`, `/out:${path.join(sdk, 'vulkan-1.lib')}`], sdk)
  await run(path.join(sdk, 'bin/glslc.exe'), ['--version'], sdk)
  const major = installation.installationVersion.split('.')[0]
  const generator = major === '18' ? 'Visual Studio 18 2026' : 'Visual Studio 17 2022'
  const build = path.join(work, 'build')
  for (const args of windowsVulkanCommands(work, build, sdk, generator)) await run(cmake, args, work)
  const bundle = path.join(work, 'bundle'), filesRoot = path.join(bundle, 'whisper'); await fs.mkdir(filesRoot, { recursive: true })
  for (const [from, name] of [
    [path.join(build, 'bin/Release/whisper-cli.exe'), 'whisper-cli.exe'], [path.join(sdk, 'bin/vulkan-1.dll'), 'vulkan-1.dll'],
    [path.join(work, 'LICENSE'), 'LICENSE-whisper.txt'], [path.join(sdk, 'share/licenses/vulkan-loader/LICENSE'), 'LICENSE-vulkan-loader.txt']
  ]) await fs.copyFile(from, path.join(filesRoot, name))
  // Header licenses apply to the statically built code as well.
  const headerLicenses = path.join(sdk, 'share/licenses/vulkan-headers')
  for (const name of await fs.readdir(headerLicenses)) await fs.copyFile(path.join(headerLicenses, name), path.join(filesRoot, `LICENSE-vulkan-headers-${name}`))
  await fs.writeFile(path.join(filesRoot, 'SOURCE.txt'), `whisper.cpp b5130 (MIT): ${source.url}\nSHA-256: ${source.sha256}\nVulkan headers/loader: pinned scripts/windows-vulkan-build-tools.json\nRecipe: scripts/windows-vulkan-runtime.mjs\n`)
  await refreshWindowsVulkanInventory(bundle, { commands: windowsVulkanCommands(work, build, sdk, generator), toolchain: { visualStudio: installation.installationVersion, cmake: (await execute(cmake, ['--version'])).stdout.split('\n')[0] } })
  await verifyWindowsVulkanBundle(bundle)
  // Promote only within this explicit build output. Keep a prior bundle recoverable.
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const staging = `${destination}.stage-${randomUUID()}`
  await fs.cp(bundle, staging, { recursive: true, force: false, errorOnExist: true })
  await verifyWindowsVulkanBundle(staging)
  const previous = `${destination}.previous-${randomUUID()}`
  const hadPrevious = await fs.rename(destination, previous).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false })
  try { await fs.rename(staging, destination) }
  catch (cause) { if (hadPrevious) await fs.rename(previous, destination); throw cause }
  assert.equal(await fs.realpath(path.dirname(work)), await fs.realpath(os.tmpdir()))
  assert.ok(path.basename(work).startsWith('jv-') && !(await fs.lstat(work)).isSymbolicLink())
  await fs.rm(work, { recursive: true, force: true })
  return destination
}
