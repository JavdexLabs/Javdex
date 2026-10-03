import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { inspectLinuxPlaybackBinary, inspectMacPlaybackBinary, stagePackagedPlaybackRuntime, validatePlaybackRuntime, verifyPackagedPlaybackRuntime } from './playback-runtime.mjs'

const target = { platformName: 'darwin', archName: process.arch === 'x64' ? 'x64' : 'arm64', electronVersion: '43.4.1' }
const hash = value => createHash('sha256').update(value).digest('hex')
function fixture(t, runtimeTarget = target) {
  const target = runtimeTarget
  const root = mkdtempSync(path.join(tmpdir(), 'javdex-playback-runtime-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'matrix', target.platformName + '-' + target.archName)
  mkdirSync(path.join(directory, 'lib'), { recursive: true })
  const libraryName = target.platformName === 'linux' ? 'lib/libfixture.so.1' : 'lib/libfixture.dylib'
  const runtimeName = target.platformName === 'linux' ? 'playback-helper' : 'playback.node'
  const payload = { [runtimeName]: 'synthetic runtime', [libraryName]: 'synthetic library',
    'licenses/LICENSE.txt': 'test-only notice, not a license audit', 'sources/fixture.tar': 'unit-test source placeholder',
    'sources/build.txt': 'unit-test build placeholder' }
  for (const [file, value] of Object.entries(payload)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    writeFileSync(path.join(directory, file), value)
  }
  if (target.platformName === 'linux') chmodSync(path.join(directory, runtimeName), 0o755)
  const component = { version: 'test', license: 'MIT', licenseFile: 'licenses/LICENSE.txt', sourceArchive: 'sources/fixture.tar', buildRecipe: 'sources/build.txt' }
  const manifest = { schemaVersion: 1, hashStage: 'pre-sign', platform: target.platformName, arch: target.archName, electronVersion: target.electronVersion, mpvVersion: 'test',
    files: Object.fromEntries(Object.entries(payload).map(([name, data]) => [name, hash(data)])),
    components: [{ ...component, name: 'mpv', binaries: [libraryName] }, { ...component, name: 'Javdex runtime', binaries: [runtimeName] }] }
  const save = () => writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify(manifest))
  save()
  const context = { electronPlatformName: target.platformName, arch: target.archName === 'x64' ? 1 : 3,
    appOutDir: path.join(root, 'package'), packager: { info: { framework: { version: target.electronVersion } },
      getResourcesDir: () => path.join(root, 'package', 'Resources') } }
  return { root, directory, manifest, save, context, environment: { JAVDEX_PLAYBACK_RUNTIME_DIR: path.join(root, 'matrix') } }
}

test('runtime inventory checks hashes, exact payload and binary/source ownership through the packaging seam', t => {
  const f = fixture(t), inspected = []
  const options = { environment: f.environment, inspectBinary: (file, input) => inspected.push({ name: path.basename(file), arch: input.archName }) }
  const verified = verifyPackagedPlaybackRuntime(f.context, options)
  assert.equal(verified.binaryCount, 2)
  assert.equal(inspected.length, 2)
  const staged = stagePackagedPlaybackRuntime(f.context, options)
  assert.equal(staged.binaryCount, 2)
  assert.ok(existsSync(path.join(staged.directory, 'playback.node')))
  assert.equal(readFileSync(path.join(staged.directory, 'runtime.json'), 'utf8'), readFileSync(path.join(f.directory, 'runtime.json'), 'utf8'))
  assert.equal(inspected.length, 6, 'staging rechecks both input and copied binaries')
  assert.throws(() => stagePackagedPlaybackRuntime(f.context, options), /overwrite/)
  assert.equal(verifyPackagedPlaybackRuntime({}, { environment: {} }), null, 'ordinary development package has no implicit runtime')
})

test('runtime inventory rejects wrong targets, modified/unlisted files and missing source evidence', t => {
  const f = fixture(t)
  const check = () => validatePlaybackRuntime(f.directory, target, () => {})
  for (const [field, bad] of [['arch', 'other'], ['platform', 'win32'], ['electronVersion', '0.0.0']]) {
    const original = f.manifest[field]
    f.manifest[field] = bad; f.save()
    assert.throws(check, /target mismatch/)
    f.manifest[field] = original; f.save()
  }
  writeFileSync(path.join(f.directory, 'playback.node'), 'tampered')
  assert.throws(check, /digest mismatch/)
  writeFileSync(path.join(f.directory, 'playback.node'), 'synthetic runtime')
  writeFileSync(path.join(f.directory, 'extra.txt'), 'unexpected')
  assert.throws(check, /exactly match/)
  rmSync(path.join(f.directory, 'extra.txt'))
  f.manifest.components[0].sourceArchive = 'sources/missing.tar'; f.save()
  assert.throws(check, /missing component evidence/)
})

test('runtime inventory rejects escaping paths, symlinks and binaries without owners', t => {
  const f = fixture(t), check = () => validatePlaybackRuntime(f.directory, target, () => {})
  f.manifest.files['../outside'] = 'a'.repeat(64); f.save()
  assert.throws(check, /invalid playback inventory path/)
  delete f.manifest.files['../outside']; f.save()
  symlinkSync('playback.node', path.join(f.directory, 'alias.node'))
  assert.throws(check, /symlink/)
  rmSync(path.join(f.directory, 'alias.node'))
  f.manifest.components[1].binaries = ['lib/libfixture.dylib']; f.save()
  assert.throws(check, /duplicate playback binary ownership/)
  f.manifest.components.pop(); f.save()
  assert.throws(check, /no source\/license owner/)
})

test('native verification is fail-closed for platforms without an implemented binary inspector', t => {
  const f = fixture(t)
  f.manifest.platform = 'win32'; f.save()
  assert.throws(() => validatePlaybackRuntime(f.directory, { ...target, platformName: 'win32' }, () => {}), /not implemented for this platform/)
  assert.throws(() => verifyPackagedPlaybackRuntime(f.context, { environment: { JAVDEX_PLAYBACK_RUNTIME_DIR: '' } }), /must name/)
})

test('Linux inventory requires an isolated helper with hashes and source ownership, not the legacy addon', t => {
  const linuxTarget = { ...target, platformName: 'linux' }, f = fixture(t, linuxTarget)
  const inspected = []
  const check = () => validatePlaybackRuntime(f.directory, linuxTarget, file => inspected.push(path.basename(file)))
  check()
  assert.deepEqual(inspected.sort(), ['libfixture.so.1', 'playback-helper'])
  f.manifest.components.pop(); f.save()
  assert.throws(check, /no source\/license owner/)
  f.manifest.components.push({ ...f.manifest.components[0], name: 'Javdex runtime', binaries: ['playback-helper'] }); f.save()
  writeFileSync(path.join(f.directory, 'playback-helper'), 'tampered')
  assert.throws(check, /digest mismatch/)
  writeFileSync(path.join(f.directory, 'playback-helper'), 'synthetic runtime')
  writeFileSync(path.join(f.directory, 'playback.node'), 'synthetic addon')
  f.manifest.files['playback.node'] = hash('synthetic addon')
  f.manifest.components[1].binaries.push('playback.node'); f.save()
  assert.throws(check, /not an in-process addon/)
  rmSync(path.join(f.directory, 'playback-helper'))
  delete f.manifest.files['playback-helper']
  f.manifest.components[1].binaries = ['playback.node']; f.save()
  assert.throws(check, /missing Linux playback helper/)
})

test('Linux helper ELF validation accepts executable and PIE while rejecting unsafe interpreter and mode',
  { skip: process.platform === 'win32' ? 'POSIX executable mode validation requires a POSIX filesystem' : false }, t => {
  const f = fixture(t, { ...target, platformName: 'linux' })
  const helper = path.join(f.directory, 'playback-helper'), library = path.join(f.directory, 'lib/libfixture.so.1')
  const header = interpreter => {
    const name = Buffer.from(interpreter + '\0'), data = Buffer.alloc(64 + 56 + name.length)
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(data)
    data.writeUInt16LE(3, 16); data.writeUInt16LE(183, 18); data.writeUInt32LE(1, 20)
    data.writeBigUInt64LE(1n, 24); data.writeBigUInt64LE(64n, 32)
    data.writeUInt16LE(56, 54); data.writeUInt16LE(1, 56)
    data.writeUInt32LE(3, 64); data.writeBigUInt64LE(120n, 72); data.writeBigUInt64LE(BigInt(name.length), 96)
    name.copy(data, 120)
    return data
  }
  const input = { directory: f.directory, archName: 'arm64', binaryFiles: new Set([helper, library]) }
  const dynamic = '0x01 (NEEDED) Shared library: [libfixture.so.1]\n0x1d (RUNPATH) Library runpath: [$ORIGIN/lib]\n0x0 (NULL) 0x0\n'
  const inspect = () => inspectLinuxPlaybackBinary(helper, input, () => dynamic)
  const valid = header('/lib/ld-linux-aarch64.so.1')
  for (const type of [2, 3]) {
    const data = Buffer.from(valid); data.writeUInt16LE(type, 16)
    writeFileSync(helper, data); inspect()
  }
  chmodSync(helper, 0o644)
  assert.throws(inspect, /must be executable/)
  chmodSync(helper, 0o755)
  for (const interpreter of ['/opt/development/ld-linux-aarch64.so.1', '/lib/ld-musl-aarch64.so.1', '/lib64/ld-linux-x86-64.so.2']) {
    writeFileSync(helper, header(interpreter))
    assert.throws(inspect, /system glibc interpreter/)
  }
  for (const [mutate, message] of [
    [data => data.writeUInt16LE(1, 16), /executable or PIE/],
    [data => data.writeBigUInt64LE(0n, 24), /entry point/],
    [data => data.writeBigUInt64LE(999999999n, 32), /program headers/],
    [data => data.writeUInt16LE(0, 56), /program headers/],
    [data => data.writeUInt32LE(1, 64), /system glibc interpreter/],
    [data => data.writeBigUInt64LE(999999999n, 96), /interpreter/]
  ]) {
    const data = Buffer.from(valid); mutate(data); writeFileSync(helper, data)
    assert.throws(inspect, message)
  }
})

test('Linux ELF inspection rejects wrong architectures, unsafe search and missing non-system dependency closure', t => {
  const f = fixture(t, { ...target, platformName: 'linux' })
  const addon = path.join(f.directory, 'playback.node'), library = path.join(f.directory, 'lib/libfixture.so.1')
  const header = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header)
  header.writeUInt16LE(3, 16); header.writeUInt16LE(183, 18); header.writeUInt32LE(1, 20)
  writeFileSync(addon, header)
  const input = { directory: f.directory, archName: 'arm64', binaryFiles: new Set([addon, library]) }
  const dynamic = (...lines) => lines.join('\n') + '\n 0x0000000000000000 (NULL) 0x0\n'
  const needed = '0x0000000000000001 (NEEDED) Shared library: [libfixture.so.1]'
  const runpath = value => '0x000000000000001d (RUNPATH) Library runpath: [' + value + ']'
  const inspect = (...lines) => inspectLinuxPlaybackBinary(addon, input, () => dynamic(...lines))
  inspect(needed, runpath('$ORIGIN/lib'), '0x01 (NEEDED) Shared library: [libc.so.6]', '0x01 (NEEDED) Shared library: [libGLX.so.0]')
  inspect(needed, runpath('${ORIGIN}/lib'))
  assert.throws(() => inspectLinuxPlaybackBinary(addon, { ...input, archName: 'x64' }, () => dynamic()), /architecture/)
  for (const value of ['/usr/lib', '/opt/development/lib', '$ORIGIN/../../elsewhere', '$ORIGIN/lib:', '$ORIGIN/$LIB', '']) {
    assert.throws(() => inspect(needed, runpath(value)), /non-local|escapes/)
  }
  assert.throws(() => inspect(needed), /absent/)
  assert.throws(() => inspect(needed, runpath('$ORIGIN')), /absent/)
  assert.throws(() => inspect(needed, runpath('$ORIGIN'), '0x000f (RPATH) Library rpath: [$ORIGIN/lib]'), /absent/, 'RUNPATH overrides RPATH')
  assert.throws(() => inspect('0x01 (NEEDED) Shared library: [/usr/lib/libfixture.so.1]', runpath('$ORIGIN/lib')), /non-canonical/)
  assert.throws(() => inspect('0x01 (NEEDED) Shared library: [libavcodec.so.60]', runpath('$ORIGIN/lib')), /absent/, 'system lookup is not permission to omit codecs')
  assert.throws(() => inspect('0x01 (AUDIT) Audit library: [libaudit.so]'), /indirection/)
  assert.throws(() => inspect('0x0e (SONAME) Library soname: [other.node]'), /SONAME/)
  assert.throws(() => inspect('0x01 (NEEDED) truncated'), /unrecognized/)
  assert.throws(() => inspectLinuxPlaybackBinary(addon, input, () => ''), /dynamic section/)
  header[4] = 1; writeFileSync(addon, header)
  assert.throws(inspect, /64-bit/)
  writeFileSync(addon, 'not an ELF file')
  assert.throws(inspect, /not ELF/)
})

test('Linux executable and PIE helpers retain their runtime-local dependency after relocation',
  { skip: process.platform !== 'linux' ? 'real ELF compilation/loading requires Linux (also run in isolated Docker)'
    : !process.report.getReport().header.glibcVersionRuntime ? 'audited Linux helper targets require glibc' : false }, t => {
    const linuxTarget = { ...target, platformName: 'linux' }
    const run = (command, args) => {
      const env = { ...process.env }
      delete env.LD_LIBRARY_PATH
      delete env.LD_PRELOAD
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000, env })
      if (result.error) throw result.error
      assert.equal(result.status, 0, result.stderr)
      return result.stdout
    }
    for (const [type, flags] of [[2, ['-fno-pie', '-no-pie']], [3, ['-fPIE', '-pie']]]) {
      const f = fixture(t, linuxTarget)
      const source = path.join(f.root, 'fixture.c'), helperSource = path.join(f.root, 'helper.c')
      writeFileSync(source, 'int fixture_value(void) { return 17; }\n')
      writeFileSync(helperSource, '#include <stdio.h>\nextern int fixture_value(void);\nint main(void) { printf("%d\\n",fixture_value()); return 0; }\n')
      const library = path.join(f.directory, 'lib/libfixture.so.1'), helper = path.join(f.directory, 'playback-helper')
      run('cc', ['-shared', '-fPIC', source, '-Wl,-soname,libfixture.so.1', '-o', library])
      const compile = search => run('cc', [...flags, helperSource, library, '-Wl,-rpath,' + search, '-o', helper])
      compile('$ORIGIN/lib')
      assert.equal(readFileSync(helper).readUInt16LE(16), type)
      const binaryFiles = new Set([helper, library])
      const input = { directory: f.directory, archName: linuxTarget.archName, binaryFiles }
      for (const file of binaryFiles) inspectLinuxPlaybackBinary(file, input)
      for (const name of Object.keys(f.manifest.files)) f.manifest.files[name] = hash(readFileSync(path.join(f.directory, name)))
      f.save()
      const staged = stagePackagedPlaybackRuntime(f.context, { environment: f.environment })
      const stagedHelper = path.join(staged.directory, 'playback-helper')
      assert.equal(run(stagedHelper, []).trim(), '17')
      compile('/opt/development/lib')
      assert.throws(() => inspectLinuxPlaybackBinary(helper, input), /non-local/)
      compile('$ORIGIN/lib')
      assert.throws(() => inspectLinuxPlaybackBinary(helper, { ...input, archName: linuxTarget.archName === 'arm64' ? 'x64' : 'arm64' }), /architecture/)
      rmSync(f.directory, { recursive: true })
      assert.equal(run(stagedHelper, []).trim(), '17', 'relocated helper does not depend on its development tree')
      assert.throws(() => inspectLinuxPlaybackBinary(stagedHelper,
        { directory: staged.directory, archName: linuxTarget.archName, binaryFiles: new Set([stagedHelper]) }), /absent/)
      chmodSync(stagedHelper, 0o644)
      assert.throws(() => validatePlaybackRuntime(staged.directory, linuxTarget), /must be executable/,
        'staging validation checks executable mode even though content hashes do not cover it')
    }
  })

test('macOS Mach-O fixture loads its runtime-local dependency after relocation, and rejects absolute/missing links',
  { skip: process.platform !== 'darwin' ? 'Mach-O inspection and loading require macOS' : false }, t => {
    const f = fixture(t)
    const source = path.join(f.root, 'fixture.c'), addonSource = path.join(f.root, 'addon.c'), probeSource = path.join(f.root, 'probe.c')
    writeFileSync(source, 'int fixture_value(void) { return 17; }\n')
    writeFileSync(addonSource, 'extern int fixture_value(void); int playback_fixture(void) { return fixture_value(); }\n')
    writeFileSync(probeSource, '#include <dlfcn.h>\n#include <stdio.h>\nint main(int argc, char **argv) { if(argc != 2) return 1; void *h=dlopen(argv[1], RTLD_NOW); if(!h) return 2; int (*f)(void)=dlsym(h,"playback_fixture"); if(!f) return 3; printf("%d\\n",f()); dlclose(h); return 0; }\n')
    const run = (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 })
      if (result.error) throw result.error
      assert.equal(result.status, 0, result.stderr)
      return result.stdout
    }
    const library = path.join(f.directory, 'lib/libfixture.dylib')
    const arch = target.archName === 'x64' ? 'x86_64' : 'arm64'
    run('clang', ['-arch', arch, '-dynamiclib', source, '-install_name', '@rpath/libfixture.dylib', '-o', library])
    const addon = path.join(f.directory, 'playback.node')
    run('clang', ['-arch', arch, '-bundle', addonSource, library, '-o', addon])
    run('install_name_tool', ['-change', '@rpath/libfixture.dylib', '@loader_path/lib/libfixture.dylib', addon])
    const binaryFiles = new Set([addon, library])
    for (const file of binaryFiles) inspectMacPlaybackBinary(file, { directory: f.directory, archName: target.archName, binaryFiles })
    for (const [name] of Object.entries(f.manifest.files)) f.manifest.files[name] = hash(readFileSync(path.join(f.directory, name)))
    f.save()
    const staged = stagePackagedPlaybackRuntime(f.context, { environment: f.environment })
    const probe = path.join(f.root, 'probe')
    run('clang', ['-arch', arch, probeSource, '-o', probe])
    assert.equal(run(probe, [path.join(staged.directory, 'playback.node')]).trim(), '17')
    // Remove only our temporary source tree: the relocated fixture must not need it.
    rmSync(f.directory, { recursive: true })
    assert.equal(run(probe, [path.join(staged.directory, 'playback.node')]).trim(), '17')
    const stagedAddon = path.join(staged.directory, 'playback.node')
    const stagedFiles = new Set([stagedAddon, path.join(staged.directory, 'lib/libfixture.dylib')])
    run('install_name_tool', ['-change', '@loader_path/lib/libfixture.dylib', '/opt/homebrew/lib/libfixture.dylib', stagedAddon])
    assert.throws(() => inspectMacPlaybackBinary(stagedAddon, { directory: staged.directory, archName: target.archName, binaryFiles: stagedFiles }), /non-local dependency/)
    run('install_name_tool', ['-change', '/opt/homebrew/lib/libfixture.dylib', '@loader_path/lib/missing.dylib', stagedAddon])
    assert.throws(() => inspectMacPlaybackBinary(stagedAddon, { directory: staged.directory, archName: target.archName, binaryFiles: stagedFiles }), /absent from the inventory/)
    assert.throws(() => inspectMacPlaybackBinary(stagedAddon, { directory: staged.directory, archName: target.archName === 'arm64' ? 'x64' : 'arm64', binaryFiles: stagedFiles }), /architecture/)
  })
