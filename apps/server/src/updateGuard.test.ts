import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { readUpdateGuard } from './updateGuard'

test('pending updates cannot open business access with a missing, damaged or different-job guard', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-update-guard-'))
  const id = randomUUID()
  try {
    assert.equal(readUpdateGuard(directory, undefined), 'normal')
    assert.throws(() => readUpdateGuard(directory, id), /维护标记/)
    const file = path.join(directory, 'server-update-guard.json')
    fs.writeFileSync(file, JSON.stringify({ id, phase: 'verifying' }))
    assert.equal(readUpdateGuard(directory, id), 'verifying')
    assert.throws(() => readUpdateGuard(directory, undefined), /维护标记/)
    fs.writeFileSync(file, JSON.stringify({ id, phase: 'active' }))
    assert.equal(readUpdateGuard(directory, id), 'active')
    assert.throws(() => readUpdateGuard(directory, randomUUID()), /维护标记/)
    fs.writeFileSync(file, '{}')
    assert.throws(() => readUpdateGuard(directory, id), /维护标记/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
