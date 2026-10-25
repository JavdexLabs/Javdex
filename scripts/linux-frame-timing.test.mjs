import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('both helper clocks share target/epoch metadata without a display or libmpv', { skip: process.platform === 'win32' ? 'POSIX c++ compile runner; native helper timing tests also run in Linux release builds' : false }, t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'javdex-frame-timing-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'timing-test')
  for (const [command, args] of [['c++', ['-std=c++17', '-UNDEBUG', 'apps/desktop/src/main/player/native/linuxFrameTiming.test.cpp', '-o', output]], [output, []]]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr)
  }
})
