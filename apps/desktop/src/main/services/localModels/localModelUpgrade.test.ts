import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createLocalModelManager } from './localModelManager'

const options = { runtimeSupported: () => false, detectDevices: async () => [] }
const oldModelSettings = JSON.stringify({ schemaVersion: 3, revision: 'published-config', assignments: [
  { workloadId: 'app-default', model: { mode: 'explicit', modelRef: 'existing-translation-model' } }
] })

test('0.8.0 profiles without local-models.json keep application-default translation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-upgrade-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  // The cloud document belongs to modelManagement; local models must not parse or rewrite it.
  const cloud = path.join(root, 'ai-configuration.json')
  await fs.writeFile(cloud, oldModelSettings)
  const manager = createLocalModelManager(root, options)
  try {
    assert.equal(await manager.mode(), 'app-default')
    assert.equal((await manager.snapshot()).usage.textTranslation.mode, 'app-default')
    assert.equal(await fs.readFile(cloud, 'utf8'), oldModelSettings)
  } finally { await manager.close() }
  const restarted = createLocalModelManager(root, options)
  try { assert.equal(await restarted.mode(), 'app-default') } finally { await restarted.close() }
})

test('fresh local defaults remain local after cloud settings appear on a later launch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-fresh-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const first = createLocalModelManager(root, options)
  try { assert.equal(await first.mode(), 'local') } finally { await first.close() }
  await fs.writeFile(path.join(root, 'ai-configuration.json'), oldModelSettings)
  const second = createLocalModelManager(root, options)
  try { assert.equal(await second.mode(), 'local') } finally { await second.close() }
})

test('an explicitly saved local preference wins over the presence of older cloud settings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-explicit-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const first = createLocalModelManager(root, options)
  try {
    const { usage } = await first.snapshot()
    await first.setUsage({ ...usage, textTranslation: { ...usage.textTranslation, variant: 'hy-mt2-7b-q6_k' } })
  } finally { await first.close() }
  const saved = await fs.readFile(path.join(root, 'local-models.json'), 'utf8')
  await fs.writeFile(path.join(root, 'ai-configuration.json'), oldModelSettings)
  const second = createLocalModelManager(root, options)
  try {
    assert.equal(await second.mode(), 'local')
    assert.equal(await fs.readFile(path.join(root, 'local-models.json'), 'utf8'), saved)
  } finally { await second.close() }
})
