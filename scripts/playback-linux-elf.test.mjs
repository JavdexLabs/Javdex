// Standalone checks for the deliberately minimal Linux compile context. The full
// packaging/source/signature tests remain in playback-runtime.test.mjs.
import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { inspectLinuxPlaybackBinary } from './playback-runtime.mjs'

const unsupported = process.platform !== 'linux' ? 'requires Linux ELF compiler/loader' : !process.report.getReport().header.glibcVersionRuntime ? 'requires glibc' : false
if (process.env.JAVDEX_REQUIRE_LINUX_ELF === '1') assert.equal(unsupported, false, 'Linux ELF execution is required, not a skipped acceptance')
test('minimal Linux context inspects real executable and PIE closure after relocation', {
  skip: unsupported
}, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'javdex-linux-elf-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const run = (command, args) => {
    const env = { ...process.env }
    delete env.LD_LIBRARY_PATH; delete env.LD_PRELOAD
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, env })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const source = path.join(root, 'fixture.c'), main = path.join(root, 'main.c')
  writeFileSync(source, 'int fixture_value(void) { return 17; }\n')
  writeFileSync(main, '#include <stdio.h>\nextern int fixture_value(void);\nint main(void) { printf("%d\\n",fixture_value()); return 0; }\n')
  for (const [kind, flags] of [[2, ['-fno-pie', '-no-pie']], [3, ['-fPIE', '-pie']]]) {
    const directory = path.join(root, `input-${kind}`)
    mkdirSync(path.join(directory, 'lib'), { recursive: true })
    const library = path.join(directory, 'lib/libfixture.so.1'), helper = path.join(directory, 'playback-helper')
    run('cc', ['-shared', '-fPIC', source, '-Wl,-soname,libfixture.so.1', '-o', library])
    const compile = search => run('cc', [...flags, main, library, `-Wl,-rpath,${search}`, '-o', helper])
    compile('$ORIGIN/lib')
    assert.equal(readFileSync(helper).readUInt16LE(16), kind)
    const input = { directory, archName: process.arch, binaryFiles: new Set([helper, library]) }
    for (const file of input.binaryFiles) inspectLinuxPlaybackBinary(file, input)
    const moved = path.join(root, `moved-${kind}`)
    cpSync(directory, moved, { recursive: true })
    compile('/opt/development/lib')
    assert.throws(() => inspectLinuxPlaybackBinary(helper, input), /non-local/)
    assert.throws(() => inspectLinuxPlaybackBinary(library, { ...input, archName: process.arch === 'arm64' ? 'x64' : 'arm64' }), /architecture/)
    rmSync(directory, { recursive: true })
    const movedHelper = path.join(moved, 'playback-helper'), movedLibrary = path.join(moved, 'lib/libfixture.so.1')
    const relocated = { directory: moved, archName: process.arch, binaryFiles: new Set([movedHelper, movedLibrary]) }
    for (const file of relocated.binaryFiles) inspectLinuxPlaybackBinary(file, relocated)
    assert.equal(run(movedHelper, []).trim(), '17', 'the old development tree must not be needed')
    assert.throws(() => inspectLinuxPlaybackBinary(movedHelper, { ...relocated, binaryFiles: new Set([movedHelper]) }), /absent/)
    chmodSync(movedHelper, 0o644)
    assert.throws(() => inspectLinuxPlaybackBinary(movedHelper, relocated), /executable/)
  }
})
