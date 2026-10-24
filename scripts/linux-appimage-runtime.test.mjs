import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, truncateSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { appImageRuntime, configureAppImageRuntime, prepareAutomaticAppImageRuntime, verifyAppImageRuntimePrefix } from './linux-appimage-runtime.mjs'

const tools = await prepareAutomaticAppImageRuntime()
const directory = mkdtempSync(path.join(tmpdir(), 'javdex-runtime-test-'))
const appdir = path.join(directory, 'AppDir')
mkdirSync(appdir)
writeFileSync(path.join(appdir, 'marker'), 'payload still available')
writeFileSync(path.join(appdir, 'AppRun'), `#!/bin/sh
printf '%s\n' "$APPDIR" "$@"
if [ -n "\${START_FILE:-}" ]; then printf '%s' "$APPDIR" > "$START_FILE"; fi
sleep "\${HOLD_SECONDS:-0}"
test -f "$APPDIR/marker" || exit 99
exit "\${APP_EXIT_CODE:-0}"
`, { mode: 0o755 })
const payload = path.join(directory, 'payload.squashfs')
execFileSync(tools.mksquashfs, [appdir, payload, '-noappend', '-quiet', '-no-progress', '-processors', '1', '-comp', 'zstd'])
const image = path.join(directory, 'Test with spaces.AppImage')
writeFileSync(image, Buffer.concat([readFileSync(tools.runtime), readFileSync(payload)]))
chmodSync(image, 0o755)
const environment = { ...process.env, TMPDIR: directory }
for (const key of ['APPIMAGE_EXTRACT_AND_RUN', 'APPIMAGE_TARGET_DIR', 'APPDIR', 'NO_CLEANUP', 'APPIMAGE_UNSHARE']) delete environment[key]
assert.equal(process.arch, 'x64', 'this pinned runtime acceptance is Linux x86_64 only')
// Test-process-only restrictions emulate a container: FUSE cannot elevate and
// unshare returns EPERM before it can partially change namespace state.
const filter = path.join(directory, 'deny-unshare.bpf')
const instructions = [[0x20, 0, 0, 0], [0x15, 0, 1, 272], [0x06, 0, 0, 0x50001], [0x06, 0, 0, 0x7fff0000]]
const bytecode = Buffer.alloc(instructions.length * 8)
instructions.forEach(([code, jt, jf, value], i) => {
  bytecode.writeUInt16LE(code, i * 8); bytecode[i * 8 + 2] = jt; bytecode[i * 8 + 3] = jf
  bytecode.writeUInt32LE(value, i * 8 + 4)
})
writeFileSync(filter, bytecode)
const restricted = ['-p', 'unconfined', '--', '/usr/bin/setpriv', '--no-new-privs', '--seccomp-filter', filter]
const command = args => [...restricted, image, ...args]

test('pinned runtime configuration verifies its upstream bytes and rejects tampering', () => {
  verifyAppImageRuntimePrefix(readFileSync(tools.runtime))
  const invalid = readFileSync(path.join(path.dirname(tools.directory), `uruntime-${appImageRuntime.version}.original`))
  invalid[100] ^= 1
  assert.throws(() => configureAppImageRuntime(invalid), /checksum mismatch/)
})

test('failed mount automatically extracts, preserves arguments, and returns app failure without retry', () => {
  const result = execFileSync('aa-exec', command(['--javdex-cpu', '/tmp/media with spaces.avi']), {
    env: environment, encoding: 'utf8', timeout: 30000
  }).trim().split('\n')
  assert.match(result[0], /appimage_extracted_/)
  assert.deepEqual(result.slice(1), ['--javdex-cpu', '/tmp/media with spaces.avi'])
  assert.throws(() => execFileSync('aa-exec', command([]), {
    env: { ...environment, APP_EXIT_CODE: '42' }, timeout: 30000, stdio: 'pipe'
  }), error => error.status === 42 && error.stdout.toString().trim().split('\n').length === 1)
})

test('automatic extraction still works for images larger than the upstream 350 MiB default limit', () => {
  const large = path.join(directory, 'Large.AppImage')
  writeFileSync(large, readFileSync(image))
  truncateSync(large, 351 * 1024 * 1024) // Sparse trailing padding; payload is unchanged.
  chmodSync(large, 0o755)
  const output = execFileSync('aa-exec', [...restricted, large], {
    env: environment, encoding: 'utf8', timeout: 30000
  })
  assert.match(output, /appimage_extracted_/)
})

test('a short overlapping launch cannot clean files used by a longer launch', async () => {
  const started = path.join(directory, 'started')
  const first = spawn('aa-exec', command([]), {
    env: { ...environment, START_FILE: started, HOLD_SECONDS: '8' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = ''
  first.stdout.on('data', chunk => { stdout += chunk })
  first.stderr.on('data', chunk => { stderr += chunk })
  const completion = new Promise((resolve, reject) => {
    first.on('error', reject)
    first.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${code}/${signal}: ${stderr}`)))
  })
  try {
    const deadline = Date.now() + 20000
    while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert(existsSync(started), 'long launch reached AppRun')
    const target = readFileSync(started, 'utf8')
    const second = execFileSync('aa-exec', command([]), { env: environment, encoding: 'utf8', timeout: 30000 }).trim()
    assert.equal(second, target, 'overlapping launches reuse the same extraction')
    await completion
    assert.equal(stdout.trim(), target)
  } finally {
    if (first.exitCode === null) first.kill('SIGTERM')
  }
})

test('a later build can prepare the complete toolset with the generated override already set', () => {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    import { readFileSync } from 'node:fs';
    import { prepareAutomaticAppImageRuntime, verifyAppImageRuntimePrefix } from './scripts/linux-appimage-runtime.mjs';
    const tools = await prepareAutomaticAppImageRuntime();
    verifyAppImageRuntimePrefix(readFileSync(tools.runtime));
    process.stdout.write(execFileSync(tools.directory + '/mksquashfs', ['-version']));
  `], { cwd: process.cwd(), env: { ...process.env, APPIMAGE_TOOLS_PATH: tools.directory }, timeout: 30000, encoding: 'utf8' })
  assert.match(result, /mksquashfs version/)
})
