import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { linuxCompileScripts, stageLinuxCompileContext } from './stage-playback-linux-context.mjs'

test('documented minimal Linux context loads its exact verification command without repository dependencies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-linux-context-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const headers = path.join(root, 'headers'), destination = path.join(root, 'context')
  fs.mkdirSync(headers)
  for (const name of ['node_api.h', 'node_version.h', 'v8.h']) fs.writeFileSync(path.join(headers, name), '// synthetic import-closure fixture only\n')
  const nested = path.join(headers, 'context')
  assert.throws(() => stageLinuxCompileContext(headers, nested), /outside the SDK/)
  assert.equal(fs.existsSync(nested), false, 'a context cannot recursively copy itself into the SDK')
  stageLinuxCompileContext(headers, destination)
  assert.deepEqual(fs.readdirSync(path.join(destination, 'scripts')).sort(), [...linuxCompileScripts].sort())
  assert.deepEqual(fs.readdirSync(destination).sort(), ['Dockerfile', 'electron-headers', 'native', 'scripts'])
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const command = ['--test', '--test-reporter=tap', 'scripts/playback-linux-elf.test.mjs']
  const result = spawnSync(process.execPath, command, { cwd: destination, encoding: 'utf8', timeout: 20_000, env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND/)
  if (process.platform === 'linux') assert.match(result.stdout, /# pass 1/)
  else {
    assert.match(result.stdout, /# skipped 1/)
    const required = spawnSync(process.execPath, command, { cwd: destination, encoding: 'utf8', env: { ...env, JAVDEX_REQUIRE_LINUX_ELF: '1' } })
    assert.notEqual(required.status, 0, 'required Linux execution cannot become a skipped pass')
  }
  const sentinel = path.join(destination, 'keep.txt')
  fs.writeFileSync(sentinel, 'must remain')
  assert.throws(() => stageLinuxCompileContext(headers, destination), /new or empty/)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain')
})
