// Real model checks against the previously isolated GPU acceptance store.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createLocalModelManager } from '../apps/desktop/src/main/services/localModels/localModelManager'
import { DEFAULT_LOCAL_MODEL_VARIANTS } from '../apps/desktop/src/main/services/localModels/modelCatalog'
import { validateModelRuntime } from '../apps/desktop/src/main/services/localModels/validateModelRuntime'
import type { LocalModelSnapshot } from '../packages/contracts/src/desktop/localModels'

async function main(): Promise<void> {
  const root = path.resolve('out/ai-runtime-acceptance/model-validation')
  const directory = path.resolve('out/ai-runtime-acceptance/gpu/runtime')
  await fs.access(path.join(directory, 'runtimes'))
  await fs.mkdir(root, { recursive: true })
  const profile = await fs.mkdtemp(path.join(root, 'profile-'))
  await fs.writeFile(path.join(profile, 'local-models.json'), JSON.stringify({ version: 2, revision: 'validation-acceptance',
    directory, selected: DEFAULT_LOCAL_MODEL_VARIANTS, downloadSource: 'official', acceleration: { mode: 'auto' },
    usage: { subtitleRecognition: { model: 'kotoba', variant: DEFAULT_LOCAL_MODEL_VARIANTS.kotoba },
      subtitleTranslation: { model: 'hy-mt2-7b', variant: DEFAULT_LOCAL_MODEL_VARIANTS['hy-mt2-7b'] },
      textTranslation: { mode: 'app-default', model: 'qwen3', variant: DEFAULT_LOCAL_MODEL_VARIANTS.qwen3 } } }))
  const report: unknown[] = []
  const fallbackOnly = process.argv.includes('--fallback-only')
  let manager = createLocalModelManager(profile)
  async function verified(name: string, expected: string): Promise<void> {
    const start = Date.now()
    let state: LocalModelSnapshot
    for (;;) {
      state = await manager.snapshot()
      const selected = state.models.flatMap(model => model.variants.filter(variant => variant.references.length))
      assert.equal(selected.length, 2)
      for (const variant of selected) {
        assert.equal(variant.ready, true, `${variant.id} files missing`)
        assert.notEqual(variant.validation?.state, 'failed', JSON.stringify(variant.validation))
        assert.equal(variant.inUse, false, 'probe must not masquerade as a production task')
        assert.equal(variant.execution, undefined, 'probe must not overwrite actual task backend')
      }
      if (selected.every(variant => variant.validation?.state === 'passed')) {
        for (const variant of selected) assert.equal(variant.validation?.execution?.backend, expected, JSON.stringify(variant.validation))
        const check = { name, elapsedMs: Date.now() - start, environments: state.environments,
          models: selected.map(({ id, validation, dependencies }) => ({ id, validation, dependencies })) }
        report.push(check); console.log(JSON.stringify(check)); break
      }
      assert.ok(Date.now() - start < 300000, 'validation timeout')
      await delay(200)
    }
  }
  try {
    if (!fallbackOnly) {
      await manager.prepareRuntime('text', 'auto')
      const start = Date.now()
      while ((await manager.snapshot()).operation) {
        assert.ok(Date.now() - start < 60000, 'shared component verification timeout')
        await delay(100)
      }
      const prepared = await manager.snapshot()
      assert.equal(prepared.error, null)
      assert.equal(prepared.downloadBytes, 0, 'existing shared components require no new download')
      assert.equal(prepared.downloadTotal, 0)
      assert.ok(prepared.environments!.every(environment => environment.cpuReady && environment.gpu.state === 'ready'))
      report.push({ name: 'shared CPU and CUDA component reuse without network downloads', downloadBytes: prepared.downloadBytes,
        environments: prepared.environments })
      await verified('automatic RTX 4080 validation before any user task', 'cuda')
      await manager.setAcceleration({ mode: 'cpu' })
      await verified('configuration change automatically validates CPU', 'cpu')
      await manager.close()
      manager = createLocalModelManager(profile, { detectDevices: async () => [] })
      await manager.setAcceleration({ mode: 'auto' })
      await verified('no GPU automatically validates CPU fallback', 'cpu')
    }
    for (const broken of [false, true]) {
      await manager.close()
      manager = createLocalModelManager(profile, { validate: (paths, model, signal) => validateModelRuntime({ ...paths,
        acceleration: { ...paths.acceleration!, runtimes: broken ? { cuda: {
          whisper: path.join(profile, 'missing-whisper.exe'), translator: path.join(profile, 'missing-translator.exe')
        } } : {} }
      }, model, signal) })
      await manager.setAcceleration({ mode: 'auto' })
      await verified(broken ? 'GPU startup failure is validated on real CPU fallback' : 'missing GPU runtime is validated on real CPU fallback', 'cpu')
    }
    await fs.writeFile(path.join(root, fallbackOnly ? 'fallback-report.json' : 'report.json'), JSON.stringify({ status: 'passed', checks: report }, null, 2))
  } finally { await manager.close() }
}
void main().catch(cause => { console.error(cause); process.exitCode = 1 })
