import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { electronBuilderArchName } from './packaging-runtime.mjs'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const aiRuntimeSources = JSON.parse(await fs.readFile(new URL('./ai-runtime-sources.json', import.meta.url), 'utf8'))
const tools = { whisper: ['whisper-cli'], ffmpeg: ['ffmpeg', 'ffprobe'] }
const sha256 = async file => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false })
  child.once('error', error => reject(new Error(`AI runtime build needs ${command}: ${error.message}`)))
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`AI runtime build failed: ${command} (${code})`)))
})
const fingerprint = createHash('sha256').update(macAiBuildCommands.toString()).update(JSON.stringify(aiRuntimeSources)).digest('hex')

export function macAiBuildCommands(arch, work) {
  assert.ok(['arm64', 'x64'].includes(arch), 'Unsupported macOS AI runtime architecture')
  const nativeArch = arch === 'x64' ? 'x86_64' : 'arm64'
  const jobs = String(Math.max(1, Math.min(6, os.availableParallelism())))
  const whisper = path.join(work, 'whisper'), ffmpeg = path.join(work, 'ffmpeg')
  return [
    ['cmake', ['-S', whisper, '-B', path.join(work, 'whisper-build'), '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_OSX_ARCHITECTURES=${nativeArch}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0', '-DBUILD_SHARED_LIBS=OFF',
      '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON',
      '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_BUILD_SERVER=OFF',
      '-DWHISPER_CURL=OFF', '-DWHISPER_COREML=OFF'], work],
    ['cmake', ['--build', path.join(work, 'whisper-build'), '--config', 'Release', '--target', 'whisper-cli', '-j', jobs], work],
    [path.join(ffmpeg, 'configure'), ['--target-os=darwin', `--arch=${nativeArch}`, '--cc=clang', '--cxx=clang++',
      ...(arch === process.arch ? [] : ['--enable-cross-compile']),
      `--extra-cflags=-arch ${nativeArch} -mmacosx-version-min=13.0`, `--extra-ldflags=-arch ${nativeArch} -mmacosx-version-min=13.0`,
      '--disable-autodetect', '--disable-gpl', '--disable-nonfree', '--disable-shared', '--enable-static',
      '--disable-doc', '--disable-debug', '--disable-x86asm', '--disable-avdevice', '--disable-encoders',
      '--enable-encoder=pcm_s16le', '--disable-muxers', '--enable-muxer=wav', '--enable-securetransport'], ffmpeg],
    ['make', ['-s', '-j', jobs, 'ffmpeg', 'ffprobe'], ffmpeg]
  ]
}

export async function refreshAiBundleInventory(directory, arch, buildFingerprint = fingerprint) {
  const assets = {}
  for (const [id, executables] of Object.entries(tools)) {
    const names = await fs.readdir(path.join(directory, id))
    for (const executable of executables) assert.ok(names.includes(executable), `Missing ${executable}`)
    assets[id] = { files: await Promise.all(names.map(async name => {
      const filename = path.join(directory, id, name), stat = await fs.lstat(filename)
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'AI bundle may contain only regular files')
      return { name, bytes: stat.size, sha256: await sha256(filename) }
    })) }
  }
  const manifest = { version: aiRuntimeSources.version, target: `darwin-${arch}`, fingerprint: buildFingerprint, sources: aiRuntimeSources, assets }
  await fs.writeFile(path.join(directory, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
export async function verifyAiBundle(directory, arch, requireFingerprint = false) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'bundle.json'), 'utf8'))
  assert.equal(manifest.version, aiRuntimeSources.version)
  assert.equal(manifest.target, `darwin-${arch}`)
  if (requireFingerprint) assert.equal(manifest.fingerprint, fingerprint)
  for (const [id, executables] of Object.entries(tools)) {
    const entries = manifest.assets[id].files
    assert.ok(entries.length > 0 && entries.length < 100)
    assert.equal(new Set(entries.map(entry => entry.name)).size, entries.length)
    for (const executable of executables) assert.ok(entries.some(entry => entry.name === executable))
    for (const entry of entries) {
      assert.ok(path.basename(entry.name) === entry.name && !['.', '..'].includes(entry.name))
      const filename = path.join(directory, id, entry.name), stat = await fs.lstat(filename)
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.bytes)
      // Windows stat cannot represent POSIX executable bits; macOS builds still enforce them.
      if (process.platform !== 'win32' && executables.includes(entry.name)) assert.ok(stat.mode & 0o111, 'AI tool is not executable')
      assert.equal(await sha256(filename), entry.sha256)
    }
  }
  return manifest
}

export async function buildMacAiRuntime(root = projectRoot, arch = process.arch) {
  assert.equal(process.platform, 'darwin', 'Build macOS AI tools on macOS')
  assert.ok(['arm64', 'x64'].includes(arch), 'Unsupported macOS AI runtime architecture')
  const destination = path.join(root, 'out/ai-runtime', `darwin-${arch}`)
  try { await verifyAiBundle(destination, arch, true); return destination } catch { /* Rebuild invalid/missing artifacts. */ }
  const buildRoot = path.join(root, 'out/ai-runtime-build')
  await fs.mkdir(path.join(buildRoot, 'sources'), { recursive: true })
  for (const source of [aiRuntimeSources.whisper, aiRuntimeSources.ffmpeg]) {
    const filename = path.join(buildRoot, 'sources', source.filename)
    if (await sha256(filename).catch(() => '') === source.sha256) continue
    const partial = `${filename}.part`
    const response = await fetch(source.url, { signal: AbortSignal.timeout(180000) })
    assert.ok(response.ok && response.body, `Could not download pinned AI source: ${source.filename}`)
    let received = 0
    await pipeline(response.body, async function* (chunks) {
      for await (const chunk of chunks) {
        received += chunk.length
        assert.ok(received <= source.bytes, 'AI source exceeds pinned size')
        yield chunk
      }
    }, createWriteStream(partial, { mode: 0o600 }))
    assert.equal(received, source.bytes)
    assert.equal(await sha256(partial), source.sha256, 'Pinned AI source hash mismatch')
    await fs.rename(partial, filename)
  }
  const work = await fs.mkdtemp(path.join(buildRoot, `darwin-${arch}-`))
  const bundle = path.join(work, 'bundle')
  try {
    for (const id of ['whisper', 'ffmpeg']) {
      await fs.mkdir(path.join(work, id))
      await fs.mkdir(path.join(bundle, id), { recursive: true })
      await run('tar', ['-xf', path.join(buildRoot, 'sources', aiRuntimeSources[id].filename), '-C', path.join(work, id), '--strip-components=1'], work)
    }
    for (const [command, args, cwd] of macAiBuildCommands(arch, work)) await run(command, args, cwd)
    for (const [id, executables] of Object.entries(tools)) {
      for (const name of executables) {
        const filename = id === 'whisper' ? path.join(work, 'whisper-build/bin', name) : path.join(work, id, name)
        await run('lipo', [filename, '-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64'], work)
        // This build must not depend on developer-installed Homebrew dylibs.
        const inspected = await new Promise((resolve, reject) => {
          const child = spawn('otool', ['-L', filename], { stdio: ['ignore', 'pipe', 'inherit'] })
          let text = ''; child.stdout.on('data', chunk => { text += chunk })
          child.once('error', reject); child.once('exit', code => code === 0 ? resolve(text) : reject(new Error('otool failed')))
        })
        assert.ok(inspected.split('\n').slice(1).filter(Boolean).every(line => /^\s+\/(usr\/lib|System\/Library)\//.test(line)), 'AI runtime depends on non-system libraries')
        await fs.copyFile(filename, path.join(bundle, id, name)); await fs.chmod(path.join(bundle, id, name), 0o755)
      }
    }
    await fs.copyFile(path.join(work, 'whisper/LICENSE'), path.join(bundle, 'whisper/LICENSE'))
    await fs.copyFile(path.join(work, 'ffmpeg/COPYING.LGPLv2.1'), path.join(bundle, 'ffmpeg/COPYING.LGPLv2.1'))
    await fs.writeFile(path.join(bundle, 'ffmpeg/SOURCE.txt'), `FFmpeg 8.1.3, LGPL-2.1-or-later; no GPL/nonfree/external codecs.\nSource: ${aiRuntimeSources.ffmpeg.url}\nSHA-256: ${aiRuntimeSources.ffmpeg.sha256}\nBuild recipe: scripts/ai-runtime-build.mjs in the corresponding Javdex source release.\n`)
    await refreshAiBundleInventory(bundle, arch)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(bundle, destination)
    return destination
  } finally { await fs.rm(work, { recursive: true, force: true }) }
}

export async function preparePackagedAiRuntime(context) {
  if (context.electronPlatformName !== 'darwin') return
  await buildMacAiRuntime(context.packager.projectDir, electronBuilderArchName(context.arch))
}
export async function stagePackagedAiRuntime(context) {
  if (context.electronPlatformName !== 'darwin') return
  const arch = electronBuilderArchName(context.arch)
  const source = path.join(context.packager.projectDir, 'out/ai-runtime', `darwin-${arch}`)
  await verifyAiBundle(source, arch, true)
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), 'ai-runtime', `darwin-${arch}`)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(source, destination, { recursive: true, dereference: false, force: false, errorOnExist: true })
}
export async function signPackagedAiTools(appPath, identity, entitlements, execute = run) {
  const root = path.join(appPath, 'Contents/Resources/ai-runtime'), signed = new Set()
  for (const target of await fs.readdir(root)) {
    assert.match(target, /^darwin-(arm64|x64)$/)
    const arch = target.slice('darwin-'.length), directory = path.join(root, target)
    await verifyAiBundle(directory, arch)
    for (const [id, names] of Object.entries(tools)) for (const name of names) {
      const filename = path.join(directory, id, name)
      await execute('codesign', ['--force', '--sign', identity, '--options', 'runtime',
        ...(identity === '-' ? ['--timestamp=none'] : ['--timestamp']), '--entitlements', entitlements, filename], appPath)
      signed.add(path.resolve(filename))
    }
    // Record signed CLI bytes BEFORE the outer app's resource seal is generated.
    await refreshAiBundleInventory(directory, arch)
  }
  return filename => signed.has(path.resolve(filename))
}
export async function verifySignedAiRuntime(context) {
  if (context.electronPlatformName !== 'darwin') return
  const arch = electronBuilderArchName(context.arch)
  const directory = path.join(context.packager.getResourcesDir(context.appOutDir), 'ai-runtime', `darwin-${arch}`)
  // Read-only afterSign: changing bundle.json here would invalidate the app seal.
  await verifyAiBundle(directory, arch)
}
