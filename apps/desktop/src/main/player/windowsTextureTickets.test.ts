import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('Windows export quota and generations execute as real portable C++ on the Mac host', {
  skip: process.platform !== 'darwin' ? 'Mac host regression; native Windows plan runs its own executable' : false
}, t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'javdex-windows-ticket-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const binary = path.join(directory, 'tickets')
  const compiled = spawnSync('clang++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-UNDEBUG',
    path.resolve('apps/desktop/src/main/player/native/windowsTextureTickets.test.cpp'), '-o', binary], { encoding: 'utf8', timeout: 30000 })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message)
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.match(result.stdout, /lifecycle PASS/)
})
