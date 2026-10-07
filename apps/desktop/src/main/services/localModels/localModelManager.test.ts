import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createLocalModelManager } from './localModelManager'
import { createAiRuntimeInstaller } from '../../player/aiSubtitles/runtimeInstaller'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-local-models-'))
  let fail = false, attempts = 0
  const installer: typeof createAiRuntimeInstaller = directory => {
    const base = createAiRuntimeInstaller(directory)
    return { ...base,
      assetsInstalled: async ids => fs.access(path.join(base.directory, ids.includes('kotoba') ? 'kotoba/ready' : 'translation-model/ready')).then(() => true, () => false),
      install: async (signal, progress, ids = []) => {
        attempts++; await delay(20, undefined, { signal })
        if (fail) throw new Error('fixture download failed')
        const folder = ids.includes('kotoba') ? 'kotoba' : 'translation-model'
        await fs.mkdir(path.join(base.directory, folder), { recursive: true })
        await fs.writeFile(path.join(base.directory, folder, 'ready'), folder)
        progress(10, folder)
      }
    }
  }
  const manager = createLocalModelManager(root, { installer })
  return { root, manager, installer, setFail: (value: boolean) => { fail = value }, attempts: () => attempts,
    cleanup: async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }) } }
}
async function idle(manager: ReturnType<typeof createLocalModelManager>): Promise<void> {
  for (let count = 0; count < 200; count++) { if (!(await manager.snapshot()).operation) return; await delay(5) }
  assert.fail('model operation did not settle')
}
test('download is exclusive, supports cancellation/retry, and prevents use until installation completes', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.manager.setTranslation('local'), /请先下载/)
    await f.manager.download('qwen3')
    await assert.rejects(f.manager.download('kotoba'), /等待/)
    await assert.rejects(f.manager.acquire(['qwen3']), /等待/)
    f.manager.cancel(); await idle(f.manager)
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'qwen3')?.installed, false)
    f.setFail(true); await f.manager.download('qwen3'); await idle(f.manager)
    assert.match((await f.manager.snapshot()).error ?? '', /续传/)
    f.setFail(false); await f.manager.download('qwen3'); await idle(f.manager)
    assert.equal(f.attempts(), 3)
    const saving = f.manager.setTranslation('local')
    await assert.rejects(f.manager.relocate(path.join(f.root, 'elsewhere')), /等待/)
    await saving
    assert.equal(await f.manager.mode(), 'local')
  } finally { await f.cleanup() }
})
test('runtime leases guard deletion/migration and deleting the selected translation model never changes mode to online', async () => {
  const f = await fixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager); await f.manager.setTranslation('local')
    const release = await f.manager.acquire(['qwen3'])
    await assert.rejects(f.manager.remove('qwen3'), /正在使用/)
    await assert.rejects(f.manager.relocate(path.join(f.root, 'elsewhere')), /正在使用/)
    release(); release()
    await f.manager.remove('qwen3')
    assert.equal(await f.manager.mode(), 'local')
    await assert.rejects(f.manager.translateText('日本語'), /未安装/)
  } finally { await f.cleanup() }
})
test('migration preserves exact model contents, persists location across restart and rejects nested/colliding locations', async () => {
  const f = await fixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager); await f.manager.setTranslation('local')
    const old = (await f.manager.snapshot()).directory
    await assert.rejects(f.manager.relocate(path.join(f.installer(old).directory, 'nested')), /互相包含/)
    const destination = path.join(f.root, 'new-models')
    const moving = f.manager.relocate(destination)
    await assert.rejects(f.manager.acquire(['qwen3']), /等待/)
    await assert.rejects(f.manager.remove('qwen3'), /等待/)
    await moving
    assert.equal(await fs.readFile(path.join(f.installer(destination).directory, 'translation-model/ready'), 'utf8'), 'translation-model')
    assert.equal(await fs.access(f.installer(old).directory).then(() => true, () => false), false)
    const restarted = createLocalModelManager(f.root, { installer: f.installer })
    assert.equal((await restarted.snapshot()).directory, destination)
    assert.equal(await restarted.mode(), 'local'); await restarted.close()
    const collision = path.join(f.root, 'collision')
    await fs.mkdir(f.installer(collision).directory, { recursive: true })
    await assert.rejects(f.manager.relocate(collision), /已有/)
    assert.equal((await f.manager.snapshot()).directory, destination)
  } finally { await f.cleanup() }
})

test('damaged configuration blocks translation routing until the user explicitly selects a mode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-local-model-invalid-'))
  await fs.writeFile(path.join(root, 'local-models.json'), '{damaged')
  const manager = createLocalModelManager(root)
  try {
    await assert.rejects(manager.mode(), /设置损坏/)
    await assert.rejects(manager.relocate(path.join(root, 'new-models')), /设置损坏/)
    await manager.setTranslation('app-default')
    assert.equal(await manager.mode(), 'app-default')
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }) }
})
