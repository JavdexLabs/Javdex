import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = process.cwd(), baseline = path.resolve(process.argv[2] ?? ''), software = process.argv.includes('--software')
assert(process.argv[2], 'Usage: node scripts/playback-linux-helper-refresh.mjs <Ubuntu-22.04-rootfs> [--software]')
const kind = software ? 'software' : 'portable', helper = software ? 'playback-software-helper' : 'playback-dmabuf-helper'
const { validatePortableRuntime, inspectPortableElf } = await import(pathToFileURL(path.join(root, 'scripts/linux-portable-runtime.mjs')))
const { playbackFileSha256: sha } = await import(pathToFileURL(path.join(root, 'scripts/playback-runtime.mjs')))
const { verifyPlaybackSource } = await import(pathToFileURL(path.join(root, 'scripts/playback-source-build.mjs')))
assert(readFileSync(path.join(baseline, 'etc/os-release'), 'utf8').includes('VERSION_ID="22.04"'))
const current = path.join(root, `out/linux-${kind}-runtime/linux-x64`), manifest = validatePortableRuntime(current)
const original = path.join(path.dirname(current), manifest.sourceBundle.filename)
assert.equal(sha(original), manifest.sourceBundle.sha256)
const workParent = path.join(root, `out/linux-${kind}-sysroot-build`); mkdirSync(workParent, { recursive: true })
const work = mkdtempSync(path.join(workParent, 'native-')), staged = path.join(work, 'runtime'), delivery = path.join(work, 'source-delivery')
const commands = []
function run(command, args = [], env = {}) {
  commands.push({ command, args })
  const r = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(r.status, 0, `${command}: ${r.stderr}`); return r.stdout.trim()
}
cpSync(current, staged, { recursive: true }); rmSync(path.join(staged, 'portable-runtime.json'))
mkdirSync(delivery); run('tar', ['-xzf', original, '-C', delivery])
const lock = JSON.parse(readFileSync('build/playback-sources.json')), source = lock.sources.find(s => s.id === 'mpv')
const archive = path.join(delivery, source.filename); verifyPlaybackSource(archive, source)
const mpv = path.join(work, 'mpv'); mkdirSync(mpv); run('tar', ['-xzf', archive, '--strip-components=1', '-C', mpv])
const vulkan = path.join(work, 'vulkan-headers'); mkdirSync(vulkan)
if (!software) {
  const headers = lock.sources.find(s => s.id === 'vulkan_headers'), archive = path.join(delivery, headers.filename)
  verifyPlaybackSource(archive, headers); run('tar', ['-xf', archive, '--strip-components=1', '-C', vulkan])
}
const sysroot = path.join(work, 'sysroot'), toolLibs = path.join(work, 'tool-libs')
mkdirSync(path.join(sysroot, 'usr'), { recursive: true }); mkdirSync(path.join(sysroot, 'lib64')); mkdirSync(toolLibs)
for (const [link, target] of [['usr/include', 'usr/include'], ['usr/lib', 'usr/lib'], ['lib', 'lib']]) symlinkSync(path.join(baseline, target), path.join(sysroot, link))
// A chroot's absolute /lib64 loader link would escape a non-root sysroot.
// Correct only the task-owned overlay, never the baseline or host filesystem.
symlinkSync('../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', path.join(sysroot, 'lib64/ld-linux-x86-64.so.2'))
const toolFiles = ['libbfd-2.38-system.so', 'libopcodes-2.38-system.so', 'libctf.so.0']
for (const f of toolFiles) cpSync(realpathSync(path.join(baseline, 'usr/lib/x86_64-linux-gnu', f)), path.join(toolLibs, f))
const compiler = path.join(baseline, 'usr/bin/x86_64-linux-gnu-g++-11'), patcher = path.join(baseline, 'usr/bin/patchelf')
const target = path.join(staged, helper)
const args = [`--sysroot=${sysroot}`, `-B${baseline}/usr/lib/gcc/x86_64-linux-gnu/11/`, `-B${baseline}/usr/bin/`, '-std=c++17', '-O2', '-Wall', '-Wextra', `-I${mpv}/include`, ...(software ? ['apps/desktop/src/main/player/native/linuxSoftwarePlayback.cpp'] : [`-I${vulkan}/include`, `-I${sysroot}/usr/include/libdrm`, 'apps/desktop/src/main/player/native/linuxDmaBufPlayback.cpp']), `-L${staged}`, '-l:libmpv.so.2', ...(!software ? ['-lEGL', '-lgbm', '-ldrm', '-ldl'] : []), `-Wl,-rpath-link,${staged}/lib`, '-o', target]
const env = { LD_LIBRARY_PATH: toolLibs, LD_PRELOAD: '' }
const compilerVersion = run(compiler, ['--version'], env)
run(compiler, args, env); run(patcher, ['--set-rpath', '$ORIGIN:$ORIGIN/lib', target])
manifest.elf[helper] = inspectPortableElf(target)
const native = path.join(root, 'apps/desktop/src/main/player/native')
const sourceFiles = Object.fromEntries(readdirSync(native).filter(f => /\.(h|cpp)$/.test(f)).map(f => [f, sha(path.join(native, f))]))
const receiptFile = path.join(staged, 'build.json'), receipt = JSON.parse(readFileSync(receiptFile))
receipt.nativeRefresh = { mode: 'Ubuntu 22.04 sysroot, unprivileged helper-only refresh', baseline, compilerVersion, tools: Object.fromEntries([compiler, patcher, ...toolFiles.map(f => path.join(toolLibs, f))].map(f => [f, sha(f)])), commands: [...commands], sourceFiles, baseSourceBundle: manifest.sourceBundle }
receipt.parentFingerprint = receipt.fingerprint
receipt.fingerprint = createHash('sha256').update(JSON.stringify(receipt.nativeRefresh)).digest('hex')
writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
rmSync(path.join(delivery, 'runtime'), { recursive: true, force: true }); cpSync(staged, path.join(delivery, 'runtime'), { recursive: true })
rmSync(path.join(delivery, 'recipe'), { recursive: true, force: true })
for (const f of new Set(run('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean))) {
  if (!existsSync(path.join(root, f))) continue
  const target = path.join(delivery, 'recipe', f); mkdirSync(path.dirname(target), { recursive: true })
  cpSync(path.join(root, f), target)
}
cpSync(fileURLToPath(import.meta.url), path.join(delivery, 'sysroot-native-refresh.mjs'))
const bundle = path.join(path.dirname(current), `Javdex-Linux-${software ? "Software" : "GPU"}-Sources-${receipt.fingerprint.slice(0, 12)}-sysroot.tar.gz`)
run('tar', ['-czf', bundle, '-C', delivery, '.'])
manifest.sourceBundle = { filename: path.basename(bundle), sha256: sha(bundle) }
function walk(directory, prefix = '') { return readdirSync(directory, { withFileTypes: true }).flatMap(f => f.isDirectory() ? walk(path.join(directory, f.name), prefix + f.name + '/') : [prefix + f.name]) }
manifest.files = Object.fromEntries(walk(staged).map(f => [f, sha(path.join(staged, f))]))
writeFileSync(path.join(staged, 'portable-runtime.json'), JSON.stringify(manifest, null, 2) + '\n')
validatePortableRuntime(staged)
renameSync(current, current + '.previous-' + Date.now()); renameSync(staged, current)
console.log(JSON.stringify({ runtime: current, sourceBundle: manifest.sourceBundle, helper: sha(path.join(current, helper)), work }, null, 2))
