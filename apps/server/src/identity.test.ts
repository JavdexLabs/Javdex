import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { bindInstance, isInstanceBound } from './identity'

describe('instance bind marker', () => {
  it('is idempotent and does not store secrets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-bind-'))
    try {
      assert.equal(isInstanceBound(root), false)
      const first = bindInstance(root, () => '2026-09-12T00:00:00.000Z')
      const second = bindInstance(root, () => '2026-09-13T00:00:00.000Z')
      assert.deepEqual(first, second)
      assert.equal(isInstanceBound(root), true)
      const raw = fs.readFileSync(path.join(root, 'instance-bind.json'), 'utf8')
      assert.doesNotMatch(raw, /password|token|secret|epoch|serverId/i)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
