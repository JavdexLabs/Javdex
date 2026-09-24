import { it } from 'node:test'
import assert from 'node:assert/strict'
import { agentCompactionPolicy } from './agentRuntimePolicy'

it('bounds compaction buffers for small models and caps large model buffers', () => {
  assert.deepEqual(agentCompactionPolicy(4096), { enabled: true, reserveTokens: 1024, keepRecentTokens: 1024 })
  assert.deepEqual(agentCompactionPolicy(128000), { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 })
  assert.throws(() => agentCompactionPolicy(0), /正整数/)
})
