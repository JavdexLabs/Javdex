import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createLocalModelManager } from './localModelManager'
import { createAiRuntimeInstaller } from './runtimeInstaller'
import { localAiDirectories } from './modelStorage'
import { modelDownloadFile } from './modelStorage'
import { localModelVariant } from './modelCatalog'

test('cleanup refreshes partial-file inventory, resume bytes and storage before returning', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-cleanup-inventory-')))
  const manager = createLocalModelManager(root, { runtimeSupported: () => true, detectDevices: async () => [] })
  try {
    const state = await manager.snapshot(), variant = localModelVariant('qwen3')
    const partial = modelDownloadFile(state.directory, variant.asset)
    await fs.mkdir(path.dirname(partial), { recursive: true }); await fs.writeFile(partial, 'partial')
    await manager.detectDevices()
    const before = await manager.snapshot()
    const precision = (value: typeof before) => value.models.find(model => model.id === 'qwen3')!.variants.find(item => item.id === variant.id)!
    assert.equal(precision(before).hasFiles, true)
    assert.equal(precision(before).preparation!.downloadBytes, variant.asset.bytes - 7)
    assert.equal(before.storage!.downloads.bytes, 7)
    await manager.cleanDownloads()
    const after = await manager.snapshot()
    assert.equal(precision(after).hasFiles, false)
    assert.equal(precision(after).preparation!.downloadBytes, variant.asset.bytes)
    assert.deepEqual(after.storage!.downloads, { bytes: 0, files: 0 })
    await assert.rejects(fs.stat(partial), { code: 'ENOENT' })
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }) }
})

async function fixture(options: { inference?: NonNullable<Parameters<typeof createLocalModelManager>[1]>['inference']; runtimeSupported?: () => boolean; runtimeAvailable?: () => boolean;
  validate?: NonNullable<Parameters<typeof createLocalModelManager>[1]>['validate']; assetAvailable?: (id: string) => boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-local-models-'))
  let fail = false, attempts = 0
  const downloadUrls: string[] = []
  const removedAssets: string[] = []
  const installer: typeof createAiRuntimeInstaller = (directory, download, assets, settings) => {
    const base = createAiRuntimeInstaller(directory, download, assets, settings)
    const modelFile = (id: string): string => `${id === 'kotoba' ? base.paths().kotoba : id === 'qwen-asr' ? base.paths().qwenAsr!.model : base.paths().translationModel}.ready`
    const weights = (ids: readonly string[]) => ids.filter(id => id === 'kotoba' || id === 'translation-model' || id === 'qwen-asr')
    const assetsInstalled = async (ids: readonly string[]) => (!ids.some(id => !['kotoba', 'translation-model', 'qwen-asr'].includes(id)) || options.runtimeAvailable?.() !== false)
      && ids.every(id => options.assetAvailable?.(id) !== false)
      && (await Promise.all(weights(ids).map(id => fs.access(modelFile(id)).then(() => true, () => false)))).every(Boolean)
    return { ...base,
      installed: () => assetsInstalled(['kotoba', 'translation-model']), assetsInstalled,
      removeAsset: async id => { removedAssets.push(id); if (weights([id]).length) await fs.rm(modelFile(id), { force: true }) },
      install: async (signal, progress, ids = []) => {
        downloadUrls.push(...(assets ?? []).map(asset => asset.url))
        if (weights(ids).length) attempts++
        await delay(20, undefined, { signal })
        if (fail) throw new Error('fixture download failed')
        for (const id of weights(ids)) {
          const file = modelFile(id)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, id)
          progress(10, id)
        }
      }
    }
  }
  const manager = createLocalModelManager(root, { installer, runtimeSupported: () => true, detectDevices: async () => [], validate: async () => ({ backend: 'cpu' }), ...options })
  return { root, manager, installer, downloadUrls, removedAssets, setFail: (value: boolean) => { fail = value }, attempts: () => attempts,
    cleanup: async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }) } }
}
async function idle(manager: ReturnType<typeof createLocalModelManager>): Promise<void> {
  for (let count = 0; count < 200; count++) { if (!(await manager.snapshot()).operation) return; await delay(5) }
  assert.fail('model operation did not settle')
}

test('ForcedAligner switch persists, changes Qwen dependencies and cache identity, and protects active leases', { skip: process.platform !== 'win32' ? 'audio.cpp host integration is Windows-only' : false }, async () => {
  const f = await fixture({ assetAvailable: id => id !== 'qwen-aligner' })
  let release = () => {}
  try {
    const initial = await f.manager.snapshot()
    const environment = (value: typeof initial) => value.environments!.find(item => item.group === 'qwen-speech')!
    assert.equal(initial.qwenForcedAligner, true)
    assert.equal(environment(initial).cpuReady, false)
    await assert.rejects(f.manager.setQwenForcedAligner(false, 'stale'), /已更新/)
    await f.manager.setQwenForcedAligner(false, initial.revision)
    const disabled = await f.manager.snapshot()
    assert.deepEqual(disabled.usage, initial.usage)
    assert.equal(environment(disabled).cpuReady, true)
    assert.equal(environment(disabled).components.find(item => item.id === 'qwen-aligner-common')!.enabled, false)
    assert.equal(environment(disabled).preparation.items.some(item => item.id === 'qwen-aligner-common'), false)
    await f.manager.download('qwen3-asr'); await idle(f.manager)
    await f.manager.download('hy-mt2-7b'); await idle(f.manager)
    await f.manager.setUsage({ ...initial.usage, subtitleRecognition: { model: 'qwen3-asr', variant: 'qwen3-asr-q8_0' } })
    const unaligned = f.manager.subtitleRuntime().paths()
    assert.equal(unaligned.qwenAsr!.forcedAligner, false)
    release = await f.manager.acquireSubtitleRuntime()
    await assert.rejects(f.manager.setQwenForcedAligner(true), /正在使用/)
    assert.equal(f.manager.subtitleRuntime().paths().qwenAsr!.forcedAligner, false)
    release()
    await f.manager.setQwenForcedAligner(true)
    assert.notEqual(f.manager.subtitleRuntime().paths().asrVersion, unaligned.asrVersion)
    assert.equal(environment(await f.manager.snapshot()).cpuReady, false)
    await assert.rejects(f.manager.acquireSubtitleRuntime(), /运行环境|运行库/)
    await f.manager.setQwenForcedAligner(false)
    const config = JSON.parse(await fs.readFile(path.join(f.root, 'local-models.json'), 'utf8'))
    assert.equal(config.version, 3); assert.equal(config.qwenForcedAligner, false)
    await f.manager.close()
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true, detectDevices: async () => [], validate: async () => ({ backend: 'cpu' }) })
    try {
      assert.equal((await restarted.snapshot()).qwenForcedAligner, false)
      assert.equal(restarted.subtitleRuntime().paths().asrVersion, unaligned.asrVersion)
      assert.deepEqual(f.removedAssets, [], 'switching must retain downloaded files')
    } finally { await restarted.close() }
  } finally { release(); await f.cleanup() }
})

test('Qwen ASR binds independently, upgrades only on explicit selection and preserves Kotoba across restart', { skip: process.platform !== 'win32' ? 'audio.cpp host integration is Windows-only' : false }, async () => {
  const f = await fixture()
  let release = () => {}
  try {
    const initial = await f.manager.snapshot()
    assert.deepEqual(initial.environments?.map(environment => environment.group), ['speech', 'qwen-speech', 'text'])
    const kotobaEnvironment = initial.environments!.find(environment => environment.group === 'speech')!.components.map(component => component.id)
    assert.equal(initial.usage.subtitleRecognition.model, 'kotoba')
    await f.manager.download('qwen3-asr'); await idle(f.manager)
    assert.equal((await f.manager.snapshot()).usage.subtitleRecognition.model, 'kotoba')
    await f.manager.download('hy-mt2-7b'); await idle(f.manager)
    await f.manager.setUsage({ ...initial.usage, subtitleRecognition: { model: 'qwen3-asr', variant: 'qwen3-asr-q8_0' } })
    assert.deepEqual((await f.manager.snapshot()).environments!.find(environment => environment.group === 'speech')!.components.map(component => component.id), kotobaEnvironment)
    const before = f.manager.subtitleRuntime().paths()
    assert.equal(before.recognitionModel, 'qwen3-asr')
    assert.ok(before.qwenAsr?.model.endsWith('qwen3-asr-1.7b-q8_0.gguf'))
    assert.ok(before.kotoba.endsWith('ggml-kotoba-whisper-v2.0-q5_0.bin'))
    release = await f.manager.acquireSubtitleRuntime()
    await assert.rejects(f.manager.setUsage(initial.usage), /正在使用/)
    await assert.rejects(f.manager.download('qwen3-asr'), /正在使用/)
    release()
    await f.manager.close()
    const config = JSON.parse(await fs.readFile(path.join(f.root, 'local-models.json'), 'utf8'))
    assert.equal(config.version, 3)
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true, detectDevices: async () => [], validate: async () => ({ backend: 'cpu' }) })
    try {
      assert.equal((await restarted.snapshot()).usage.subtitleRecognition.model, 'qwen3-asr')
      assert.equal(restarted.subtitleRuntime().paths().asrVersion, before.asrVersion)
      await restarted.setUsage(initial.usage)
      assert.equal(restarted.subtitleRuntime().paths().recognitionModel, 'kotoba')
      assert.notEqual(restarted.subtitleRuntime().paths().asrVersion, before.asrVersion)
    } finally { await restarted.close() }
  } finally { release(); await f.cleanup() }
})

test('removing qwen-speech runtime preserves audio tools needed by installed Kotoba models', { skip: process.platform !== 'win32' ? 'audio.cpp runtime inventory is Windows-only' : false }, async () => {
  const f = await fixture()
  try {
    await f.manager.download('kotoba'); await idle(f.manager)
    await f.manager.removeRuntime('qwen-speech', 'cpu')
    assert.ok(f.removedAssets.includes('audiocpp'))
    assert.ok(f.removedAssets.includes('qwen-aligner'))
    assert.ok(!f.removedAssets.includes('ffmpeg'))
    assert.ok(!f.removedAssets.includes('whisper'))
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'kotoba')!.installed, true)
    await f.manager.download('qwen3-asr'); await idle(f.manager)
    await assert.rejects(f.manager.removeRuntime('qwen-speech', 'cpu'), /模型文件/)
  } finally { await f.cleanup() }
})

async function qwenFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  const { usage } = await f.manager.snapshot()
  await f.manager.setUsage({ ...usage,
    subtitleTranslation: { model: 'qwen3', variant: 'qwen3-q4_k_m' },
    textTranslation: { mode: 'app-default', model: 'qwen3', variant: 'qwen3-q4_k_m' }
  })
  return f
}

async function validated(manager: ReturnType<typeof createLocalModelManager>): Promise<void> {
  for (let count = 0; count < 200; count++) {
    const variants = (await manager.snapshot()).models.flatMap(model => model.variants).filter(variant => variant.ready && variant.references.length)
    if (variants.length && variants.every(variant => variant.validation?.state === 'passed')) return
    await delay(10)
  }
  assert.fail('automatic model validation did not settle')
}

test('selected precisions validate automatically after configuration saves without becoming production tasks', async () => {
  const checked: string[] = []
  const f = await qwenFixture({ validate: async paths => {
    checked.push(paths.translationModel)
    return { backend: paths.acceleration?.policy.mode === 'cpu' ? 'cpu' : 'cuda', device: paths.translationModel }
  } })
  try {
    for (const variant of ['qwen3-q4_k_m', 'qwen3-official-q8_0']) { await f.manager.download('qwen3', variant); await idle(f.manager) }
    const before = await f.manager.snapshot()
    await f.manager.setUsage({ ...before.usage, textTranslation: { model: 'qwen3', variant: 'qwen3-official-q8_0', mode: 'local' } })
    await validated(f.manager)
    const selected = (await f.manager.snapshot()).models.flatMap(model => model.variants).filter(variant => variant.ready && variant.references.length)
    assert.equal(selected.length, 2)
    assert.notEqual(selected[0].validation!.execution!.device, selected[1].validation!.execution!.device)
    assert.ok(selected.every(variant => !variant.inUse && !variant.execution && variant.validation?.execution?.backend === 'cuda'))
    const previousCalls = checked.length
    await f.manager.setAcceleration({ mode: 'cpu' })
    assert.ok((await f.manager.snapshot()).models.flatMap(model => model.variants).filter(variant => variant.ready && variant.references.length)
      .every(variant => variant.validation?.state === 'waiting'))
    await validated(f.manager)
    assert.equal(checked.length, previousCalls + 2)
    assert.ok((await f.manager.snapshot()).models.flatMap(model => model.variants).filter(variant => variant.ready && variant.references.length)
      .every(variant => variant.validation?.execution?.backend === 'cpu' && !variant.execution && !variant.inUse))
    const next = await f.manager.snapshot()
    await f.manager.setUsage({ ...next.usage, textTranslation: { ...next.usage.textTranslation, variant: 'qwen3-q4_k_m' } })
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'qwen3')!.variants.find(variant => variant.id === 'qwen3-official-q8_0')!.validation, undefined)
    await validated(f.manager)
  } finally { await f.cleanup() }
})

test('current execution belongs to the leased precision and late reports cannot update released models', async () => {
  let entered!: () => void, resume!: () => void
  const running = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { resume = resolve })
  const f = await qwenFixture({ inference: paths => ({ translateText: async () => {
    paths.acceleration!.status!('translation', { backend: 'cpu' }); entered(); await gate; return '译文'
  }, close: async () => {} }) })
  let release = () => {}
  try {
    for (const model of ['kotoba', 'qwen3'] as const) { await f.manager.download(model); await idle(f.manager) }
    await f.manager.download('qwen3', 'qwen3-official-q8_0'); await idle(f.manager)
    const before = await f.manager.snapshot()
    await f.manager.setUsage({ ...before.usage, textTranslation: { model: 'qwen3', variant: 'qwen3-official-q8_0', mode: 'local' } })
    release = await f.manager.acquireSubtitleRuntime()
    const paths = f.manager.subtitleRuntime().paths()
    paths.acceleration!.status!('translation', { backend: 'cuda', device: 'RTX 4080' })
    const pending = f.manager.translateText('はい'); await running
    const variants = (await f.manager.snapshot()).models.find(model => model.id === 'qwen3')!.variants
    assert.equal(variants.find(variant => variant.id === 'qwen3-q4_k_m')!.execution!.backend, 'cuda')
    assert.equal(variants.find(variant => variant.id === 'qwen3-official-q8_0')!.execution!.backend, 'cpu')
    resume(); await pending; release()
    paths.acceleration!.status!('translation', { backend: 'vulkan', device: 'stale device' })
    const final = await f.manager.snapshot()
    assert.equal(final.models.some(model => model.inUse), false)
    assert.equal(final.models.find(model => model.id === 'qwen3')!.variants.find(variant => variant.id === 'qwen3-q4_k_m')!.execution!.backend, 'cuda')
    release = await f.manager.acquireSubtitleRuntime()
    paths.acceleration!.status!('translation', { backend: 'vulkan', device: 'previous task' })
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'qwen3')!.variants.find(variant => variant.id === 'qwen3-q4_k_m')!.execution, undefined)
  } finally { resume(); release(); await f.cleanup() }
})

test('acceleration upgrades v1 only on explicit save, rejects stale/active writes and preserves v2 on restart', async () => {
  const f = await qwenFixture()
  try {
    await f.manager.setDownloadSource('official')
    const file = path.join(f.root, 'local-models.json'), original = await fs.readFile(file, 'utf8')
    assert.equal(JSON.parse(original).version, 1)
    assert.equal((await f.manager.snapshot()).acceleration?.policy.mode, 'auto')
    await assert.rejects(f.manager.setAcceleration({ mode: 'cpu' }, 'stale'), /已更新/)
    assert.equal(await fs.readFile(file, 'utf8'), original)
    await f.manager.download('qwen3'); await idle(f.manager)
    const release = await f.manager.acquire(['qwen3'])
    await assert.rejects(f.manager.setAcceleration({ mode: 'cpu' }), /正在使用/)
    release()
    await f.manager.setAcceleration({ mode: 'cpu' }, (await f.manager.snapshot()).revision)
    const saved = await fs.readFile(file, 'utf8')
    assert.equal(JSON.parse(saved).version, 2)
    const reopened = createLocalModelManager(f.root, { installer: f.installer, detectDevices: async () => [] })
    try {
      assert.deepEqual((await reopened.snapshot()).acceleration?.policy, { mode: 'cpu' })
      assert.equal(await fs.readFile(file, 'utf8'), saved)
      assert.deepEqual((await reopened.snapshot()).usage, (await f.manager.snapshot()).usage)
      assert.equal(await reopened.mode(), 'app-default')
      assert.equal((await reopened.snapshot()).translationModel, 'qwen3')
    } finally { await reopened.close() }
  } finally { await f.cleanup() }
})

test('damaged persisted GPU settings remain untouched and cannot start inference', async () => {
  const f = await fixture()
  try {
    await f.manager.setAcceleration({ mode: 'cpu' })
    const file = path.join(f.root, 'local-models.json'), config = JSON.parse(await fs.readFile(file, 'utf8'))
    const damaged = JSON.stringify({ ...config, acceleration: { mode: 'gpu' } })
    await fs.writeFile(file, damaged)
    const reopened = createLocalModelManager(f.root, { installer: f.installer, detectDevices: async () => [] })
    try {
      assert.ok((await reopened.snapshot()).configurationError)
      await assert.rejects(reopened.translateText('テスト'), /设置损坏/)
      assert.equal(await fs.readFile(file, 'utf8'), damaged)
    } finally { await reopened.close() }
  } finally { await f.cleanup() }
})
async function removeKeepingUsage(manager: ReturnType<typeof createLocalModelManager>, model: 'qwen3' | 'hy-mt2-7b'): Promise<void> {
  const state = await manager.snapshot(), family = state.models.find(item => item.id === model)!
  const variant = family.selectedVariant
  await manager.remove(model, variant)
  const after = await manager.snapshot()
  assert.deepEqual(after.usage, state.usage)
  assert.equal(after.models.find(item => item.id === model)!.variants.find(item => item.id === variant)!.readiness, 'missing-model')
}
test('download is exclusive, supports cancellation/retry, and prevents use until installation completes', async () => {
  const f = await qwenFixture()
  try {
    const initial = await f.manager.snapshot()
    assert.equal(initial.directory, path.join(f.root, 'local-ai'))
    assert.equal(initial.defaultDirectory, initial.directory)
    await assert.rejects(f.manager.setTranslation('local'), /请先下载/)
    await f.manager.download('qwen3')
    await assert.rejects(f.manager.download('kotoba'), /等待/)
    await assert.rejects(f.manager.acquire(['qwen3']), /等待/)
    f.manager.cancel(); await idle(f.manager)
    assert.equal((await f.manager.snapshot()).operationError, undefined)
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'qwen3')?.installed, false)
    f.setFail(true); await f.manager.download('qwen3'); await idle(f.manager)
    assert.match((await f.manager.snapshot()).error ?? '', /续传/)
    assert.deepEqual((await f.manager.snapshot()).operationError?.command, { action: 'download', model: 'qwen3', variant: 'qwen3-q4_k_m' })
    const attemptsBeforeRetry = f.attempts()
    f.setFail(false); await f.manager.download('qwen3'); await idle(f.manager)
    assert.equal(f.attempts(), attemptsBeforeRetry + 1)
    const saving = f.manager.setTranslation('local')
    await assert.rejects(f.manager.relocate(path.join(f.root, 'elsewhere')), /等待/)
    await saving
    assert.equal(await f.manager.mode(), 'local')
  } finally { await f.cleanup() }
})
test('runtime leases and configured purposes guard deletion; missing weights never enable online fallback', async () => {
  const f = await qwenFixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager); await f.manager.setTranslation('local')
    const release = await f.manager.acquire(['qwen3'])
    await assert.rejects(f.manager.remove('qwen3'), /正在使用/)
    await assert.rejects(f.manager.relocate(path.join(f.root, 'elsewhere')), /正在使用/)
    release(); release()
    await removeKeepingUsage(f.manager, 'qwen3')
    assert.equal(await f.manager.mode(), 'local')
    await assert.rejects(f.manager.translateText('日本語'), /未安装/)
  } finally { await f.cleanup() }
})
test('migration preserves exact model contents, persists location across restart and rejects nested/colliding locations', async () => {
  const f = await qwenFixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager); await f.manager.setTranslation('local')
    const old = (await f.manager.snapshot()).directory
    await assert.rejects(f.manager.relocate(path.join(f.installer(old).directory, 'nested')), /互相包含/)
    await assert.rejects(fs.access(path.join(old, 'nested')))
    const destination = path.join(f.root, 'new-models')
    const moving = f.manager.relocate(destination)
    await assert.rejects(f.manager.acquire(['qwen3']), /等待/)
    await assert.rejects(f.manager.remove('qwen3'), /等待/)
    await moving
    assert.equal(await fs.readFile(`${f.installer(destination).paths().translationModel}.ready`, 'utf8'), 'translation-model')
    assert.equal(await fs.access(f.installer(old).directory).then(() => true, () => false), false)
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    const canonical = await fs.realpath(destination)
    assert.equal((await restarted.snapshot()).directory, canonical)
    assert.equal(await restarted.mode(), 'local'); await restarted.close()
    const collision = path.join(f.root, 'collision')
    await fs.mkdir(f.installer(collision).directory, { recursive: true })
    await fs.writeFile(path.join(collision, 'store.json'), '{}')
    await assert.rejects(f.manager.relocate(collision), /已有/)
    assert.equal((await f.manager.snapshot()).directory, canonical)
  } finally { await f.cleanup() }
})

test('a failed location config commit rolls back promoted entries and leaves original weights usable', async () => {
  const f = await qwenFixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager)
    await f.manager.setTranslation('local')
    const old = (await f.manager.snapshot()).directory, target = path.join(f.root, 'rejected-target')
    // Make atomic config replacement fail after copy and promotion have completed.
    await fs.rm(path.join(f.root, 'local-models.json')); await fs.mkdir(path.join(f.root, 'local-models.json'))
    await assert.rejects(f.manager.relocate(target))
    assert.equal((await f.manager.snapshot()).directory, old)
    assert.equal((await f.manager.snapshot()).operation, null)
    assert.equal(await fs.readFile(`${f.installer(old).paths().translationModel}.ready`, 'utf8'), 'translation-model')
    assert.deepEqual(await fs.readdir(target), [])
  } finally { await f.cleanup() }
})

test('relocation carries resume data, leaves caches and unrelated files, and cleanup respects inference leases', async () => {
  const f = await fixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager)
    const old = (await f.manager.snapshot()).directory
    const download = path.join(old, 'downloads', 'a'.repeat(64))
    const locations = localAiDirectories(f.root)
    await fs.mkdir(download, { recursive: true }); await fs.writeFile(path.join(download, 'weight.part'), 'resume')
    await fs.writeFile(path.join(old, 'unrelated.txt'), 'keep')
    for (const root of [locations.cache, locations.work]) {
      await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'cache'), 'cached')
    }
    const next = path.join(f.root, 'relocated')
    await f.manager.relocate(next)
    assert.equal(await fs.readFile(path.join(next, 'downloads', 'a'.repeat(64), 'weight.part'), 'utf8'), 'resume')
    assert.equal(await fs.readFile(path.join(old, 'unrelated.txt'), 'utf8'), 'keep')
    await fs.access(path.join(locations.cache, 'cache'))
    const release = await f.manager.acquire(['qwen3'])
    await assert.rejects(f.manager.cleanDownloads(), /正在使用/)
    await assert.rejects(f.manager.clearCache(), /正在使用/)
    release()
    await f.manager.cleanDownloads(); await f.manager.clearCache()
    await assert.rejects(fs.access(path.join(next, 'downloads', 'a'.repeat(64))))
    for (const root of [locations.cache, locations.work]) await assert.rejects(fs.access(root))
    assert.equal((await f.manager.snapshot()).models.find(item => item.id === 'qwen3')?.installed, true)
  } finally { await f.cleanup() }
})

test('resetting an aliased default directory preserves its settings identity across restart', async () => {
  const f = await fixture()
  const alias = path.join(f.root, 'user-data-alias')
  await fs.symlink(f.root, alias, 'junction')
  const manager = createLocalModelManager(alias, { installer: f.installer, runtimeSupported: () => true })
  try {
    const defaultDirectory = (await manager.snapshot()).defaultDirectory
    await manager.download('qwen3'); await idle(manager)
    await manager.relocate(path.join(f.root, 'elsewhere'))
    await manager.relocate(defaultDirectory)
    assert.equal((await manager.snapshot()).directory, defaultDirectory)
    await manager.close()
    // Older settings can contain the canonical spelling of the same default directory.
    const configFile = path.join(f.root, 'local-models.json')
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'))
    await fs.writeFile(configFile, JSON.stringify({ ...config, directory: await fs.realpath(defaultDirectory) }))
    const restarted = createLocalModelManager(alias, { installer: f.installer, runtimeSupported: () => true })
    try {
      await restarted.relocate(defaultDirectory)
      const state = await restarted.snapshot()
      assert.equal(state.directory, state.defaultDirectory)
      assert.equal(state.models.find(model => model.id === 'qwen3')?.installed, true)
      assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).directory, defaultDirectory)
    } finally { await restarted.close() }
  } finally { await manager.close(); await f.cleanup() }
})

test('export rejects canonical and linked aliases of the managed model directory without leaving a busy operation', async () => {
  const f = await fixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager)
    const directory = (await f.manager.snapshot()).directory, canonical = await fs.realpath(directory)
    const alias = path.join(f.root, 'export-alias')
    await fs.symlink(canonical, alias, 'junction')
    for (const destination of [canonical, alias, path.join(alias, 'nested')]) {
      await assert.rejects(f.manager.exportModel('qwen3', destination), /导出目录不能位于模型保存目录内/)
      assert.equal((await f.manager.snapshot()).operation, null)
    }
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'qwen3')?.installed, true)
  } finally { await f.cleanup() }
})

test('downloading another precision does not select it; selection and all installed variants survive restart and migration', async () => {
  const f = await qwenFixture()
  try {
    const model = () => f.manager.snapshot().then(state => state.models.find(item => item.id === 'qwen3')!)
    await assert.rejects(f.manager.selectVariant('qwen3', 'qwen3-q6_k'), /先下载/)
    await f.manager.download('qwen3'); await idle(f.manager)
    await f.manager.download('qwen3', 'qwen3-q6_k'); await idle(f.manager)
    assert.equal((await model()).selectedVariant, 'qwen3-q4_k_m')
    assert.equal((await model()).variants.filter(item => item.installed).length, 2)
    await f.manager.selectVariant('qwen3', 'qwen3-q6_k')
    await f.manager.setTranslation('local')
    const release = await f.manager.acquire(['qwen3'])
    await assert.rejects(f.manager.selectVariant('qwen3', 'qwen3-q4_k_m'), /正在使用/)
    await f.manager.remove('qwen3', 'qwen3-q4_k_m')
    release()
    await f.manager.relocate(path.join(f.root, 'new-models'))
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      const state = await restarted.snapshot(), qwen = state.models.find(item => item.id === 'qwen3')!
      assert.equal(qwen.selectedVariant, 'qwen3-q6_k')
      assert.equal(qwen.variants.filter(item => item.installed).length, 1)
      assert.equal(await restarted.mode(), 'local')
      await restarted.remove('qwen3', 'qwen3-q4_k_m')
      const after = (await restarted.snapshot()).models.find(item => item.id === 'qwen3')!
      assert.equal(after.installed, true)
      assert.equal(after.selectedVariant, 'qwen3-q6_k')
      assert.deepEqual(after.variants.filter(item => item.installed).map(item => item.id), ['qwen3-q6_k'])
      await removeKeepingUsage(restarted, 'qwen3')
      assert.equal(await restarted.mode(), 'local')
      await assert.rejects(restarted.translateText('日本語'), /未安装/)
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('close drains delayed initialization before profile storage can be removed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-local-model-startup-'))
  const store = path.join(root, 'local-ai'), originalLstat = fs.lstat
  let entered!: () => void, resume!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { resume = resolve })
  let paused = false
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof originalLstat>) => {
    if (args[0] === store && !paused) { paused = true; entered(); await gate }
    return originalLstat(...args)
  })
  const manager = createLocalModelManager(root, { runtimeSupported: () => false })
  let closing: Promise<void> | undefined
  try {
    await started
    let closed = false
    closing = manager.close().then(() => { closed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(closed, false, 'close must not release the profile while startup still accesses its model directory')
    resume(); await closing
    await fs.rm(root, { recursive: true, force: true })
    await manager.snapshot()
    assert.equal(await fs.access(root).then(() => true, () => false), false)
  } finally {
    resume()
    await manager.snapshot().catch(() => {})
    await (closing ?? manager.close())
    t.mock.restoreAll()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('close can drain failed startup without hiding initialization errors from reads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-local-model-startup-failed-'))
  const store = path.join(root, 'local-ai'), originalLstat = fs.lstat
  const failure = Object.assign(new Error('fixture startup access denied'), { code: 'EACCES' })
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof originalLstat>) => {
    if (args[0] === store) throw failure
    return originalLstat(...args)
  })
  const manager = createLocalModelManager(root, { runtimeSupported: () => false })
  try {
    await assert.rejects(manager.snapshot(), failure)
    await manager.close()
    await assert.rejects(manager.mode(), failure)
  } finally {
    await manager.close()
    t.mock.restoreAll()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('new configuration starts with exact defaults and invalid variant identities cannot change it', async () => {
  const opened: Array<{ model?: string; file: string }> = []
  const f = await fixture({ inference: paths => {
    opened.push({ model: paths.translationModelId, file: paths.translationModel })
    return { translateText: async () => '译文', close: async () => {} }
  } })
  try {
    const initial = await f.manager.snapshot()
    assert.deepEqual(initial.usage, {
      subtitleRecognition: { model: 'kotoba', variant: 'kotoba-q5_0' },
      subtitleTranslation: { model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q4_k_m' },
      textTranslation: { mode: 'local', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q4_k_m' }
    })
    assert.equal(initial.translation, 'local')
    assert.equal(initial.translationModel, 'hy-mt2-7b')
    assert.equal(await f.manager.mode(), 'local')
    assert.ok(initial.models.every(model => model.variants.every(variant => !variant.installed)))
    await assert.rejects(f.manager.translateText('日本語'), /未安装/)
    await assert.rejects(f.manager.acquireSubtitleRuntime(), /未安装/)
    assert.equal(opened.length, 0)
    assert.deepEqual(f.downloadUrls, [])
    const saved = JSON.parse(await fs.readFile(path.join(f.root, 'local-models.json'), 'utf8'))
    assert.equal(saved.version, 1)
    assert.deepEqual(saved.usage, initial.usage)
    assert.equal(saved.revision, initial.revision)
    const restarted = createLocalModelManager(f.root, { installer: f.installer, detectDevices: async () => [] })
    try {
      const state = await restarted.snapshot()
      assert.deepEqual(state.models.map(item => item.selectedVariant), ['qwen3-q4_k_m', 'kotoba-q5_0', 'hy-mt2-7b-q4_k_m', 'qwen3-asr-q8_0'])
      assert.deepEqual(state.usage, initial.usage)
      await assert.rejects(restarted.selectVariant('qwen3', 'kotoba-q5_0'), /不匹配/)
      await assert.rejects(restarted.download('kotoba', '../custom-file'), /不匹配/)
      await assert.rejects(restarted.remove('qwen3', 'missing-precision'), /不匹配/)
      assert.equal((await restarted.snapshot()).operation, null)
    } finally { await restarted.close() }
    for (const model of ['kotoba', 'hy-mt2-7b'] as const) { await f.manager.download(model); await idle(f.manager) }
    assert.equal(await f.manager.translateText('日本語'), '译文')
    assert.equal(opened[0].model, 'hy-mt2-7b')
    assert.match(opened[0].file, /Hy-MT2-7B-Q4_K_M\.gguf$/)
    const release = await f.manager.acquireSubtitleRuntime()
    try {
      const paths = f.manager.subtitleRuntime().paths()
      assert.match(paths.kotoba, /kotoba-whisper-v2\.0-q5_0\.bin$/)
      assert.equal(paths.translationModelId, 'hy-mt2-7b')
      assert.equal(paths.translationModel, opened[0].file)
    } finally { release() }
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'qwen3')!.installed, false)
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

test('selection retires the idle translator and the next invocation uses the newly selected weight', async () => {
  const opened: string[] = []
  let closed = 0
  const f = await qwenFixture({ inference: paths => {
    opened.push(paths.translationModel)
    return { translateText: async () => '译文', close: async () => { closed++ } }
  } })
  try {
    await f.manager.download('qwen3'); await idle(f.manager)
    await f.manager.download('qwen3', 'qwen3-official-q8_0'); await idle(f.manager)
    await f.manager.translateText('日本語')
    await f.manager.selectVariant('qwen3', 'qwen3-official-q8_0')
    assert.equal(closed, 1)
    await f.manager.translateText('日本語')
    assert.equal(opened.length, 2)
    assert.notEqual(opened[0], opened[1])
    assert.match(opened[1], /Qwen3-1\.7B-Q8_0\.gguf$/)
    await f.manager.download('qwen3'); await idle(f.manager)
    assert.equal(closed, 2, 'repair must not attempt to replace the executable while an idle translator holds it')
    await f.manager.translateText('日本語')
    assert.equal(opened[2], opened[1])
  } finally { await f.cleanup() }
  assert.equal(closed, 3)
})

test('storing and selecting portable weights does not enable inference on an unsupported platform', async () => {
  const f = await qwenFixture({ runtimeSupported: () => false })
  try {
    await f.manager.download('qwen3', 'qwen3-q6_k'); await idle(f.manager)
    await f.manager.selectVariant('qwen3', 'qwen3-q6_k')
    const state = await f.manager.snapshot()
    assert.equal(state.supported, false)
    assert.equal(state.models.find(item => item.id === 'qwen3')!.installed, true)
    await assert.rejects(f.manager.acquire(['qwen3']), /Windows x64/)
    await assert.rejects(f.manager.setTranslation('local'), /Windows x64/)
    assert.equal(await f.manager.mode(), 'app-default')
  } finally { await f.cleanup() }
})

test('HY download and precision selection remain separate from the active translation family and mode', async () => {
  const opened: Array<{ file: string; model: string | undefined }> = []
  let closed = 0
  const f = await qwenFixture({ inference: paths => {
    opened.push({ file: paths.translationModel, model: paths.translationModelId })
    return { translateText: async () => paths.translationModelId!, close: async () => { closed++ } }
  } })
  try {
    await assert.rejects(f.manager.selectTranslationModel('hy-mt2-7b'), /先下载/)
    await f.manager.download('qwen3'); await idle(f.manager)
    await f.manager.translateText('はい')
    await f.manager.download('hy-mt2-7b', 'hy-mt2-7b-q6_k'); await idle(f.manager)
    assert.equal((await f.manager.snapshot()).translationModel, 'qwen3')
    assert.equal((await f.manager.snapshot()).models.find(item => item.id === 'hy-mt2-7b')!.selectedVariant, 'hy-mt2-7b-q4_k_m')
    await assert.rejects(f.manager.selectTranslationModel('hy-mt2-7b'), /当前精度/)
    await f.manager.selectVariant('hy-mt2-7b', 'hy-mt2-7b-q6_k')
    assert.equal((await f.manager.snapshot()).translationModel, 'qwen3')
    await f.manager.selectTranslationModel('hy-mt2-7b')
    assert.equal(await f.manager.mode(), 'app-default', 'choosing subtitle translator does not replace online text settings')
    await f.manager.setTranslation('local')
    assert.equal(await f.manager.translateText('はい'), 'hy-mt2-7b')
    assert.equal(opened[0].model, 'qwen3')
    assert.equal(opened[1].model, 'hy-mt2-7b')
    assert.match(opened[1].file, /HY-MT2-7B-Q6_K\.gguf$/)
    assert.equal(closed, 1, 'repair retires the shared idle executable before replacing it')
    await f.manager.selectTranslationModel('qwen3')
    assert.equal(closed, 2)
    assert.equal(await f.manager.translateText('はい'), 'qwen3')
    assert.equal(await f.manager.mode(), 'local')
  } finally { await f.cleanup() }
})

test('HY choices and all family weights survive restart and migration, with no fallback after deleting the active HY precision', async () => {
  const f = await fixture()
  try {
    for (const model of ['kotoba', 'qwen3', 'hy-mt2-7b'] as const) { await f.manager.download(model); await idle(f.manager) }
    await f.manager.download('hy-mt2-7b', 'hy-mt2-7b-q8_0'); await idle(f.manager)
    await f.manager.selectVariant('hy-mt2-7b', 'hy-mt2-7b-q8_0')
    await f.manager.selectTranslationModel('hy-mt2-7b'); await f.manager.setTranslation('local')
    const destination = path.join(f.root, 'new-hy-models')
    await f.manager.relocate(destination)
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      const before = await restarted.snapshot()
      assert.equal(before.translationModel, 'hy-mt2-7b')
      assert.equal(before.translation, 'local')
      assert.equal(before.models.find(item => item.id === 'hy-mt2-7b')!.selectedVariant, 'hy-mt2-7b-q8_0')
      assert.equal(before.models.find(item => item.id === 'hy-mt2-7b')!.variants.filter(item => item.installed).length, 2)
      assert.equal(restarted.subtitleRuntime().paths().translationModelId, 'hy-mt2-7b')
      assert.equal(await restarted.subtitleRuntime().installed(), true)
      const release = await restarted.acquireSubtitleRuntime()
      const used = await restarted.snapshot()
      assert.deepEqual(used.models.filter(model => model.inUse).map(model => model.id), ['kotoba', 'hy-mt2-7b'])
      release(); release()
      await removeKeepingUsage(restarted, 'hy-mt2-7b')
      const after = await restarted.snapshot()
      assert.equal(after.translationModel, 'hy-mt2-7b')
      assert.equal(after.translation, 'local')
      assert.equal(after.models.find(item => item.id === 'qwen3')!.installed, true)
      assert.equal(after.models.find(item => item.id === 'hy-mt2-7b')!.variants.find(item => item.id === 'hy-mt2-7b-q4_k_m')!.installed, true)
      await assert.rejects(restarted.translateText('はい'), /未安装/)
      assert.equal(await restarted.subtitleRuntime().installed(), false)
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('active HY leases block family changes and repairs of either shared translator without requiring Qwen for subtitles', async () => {
  const f = await fixture()
  try {
    for (const model of ['kotoba', 'hy-mt2-7b'] as const) { await f.manager.download(model); await idle(f.manager) }
    await f.manager.selectTranslationModel('hy-mt2-7b')
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'qwen3')!.installed, false)
    const release = await f.manager.acquireSubtitleRuntime()
    await assert.rejects(f.manager.selectTranslationModel('qwen3'), /正在使用/)
    await assert.rejects(f.manager.download('qwen3'), /正在使用/)
    await assert.rejects(f.manager.download('hy-mt2-7b'), /正在使用/)
    await assert.rejects(f.manager.remove('hy-mt2-7b'), /正在使用/)
    await assert.rejects(f.manager.relocate(path.join(f.root, 'another')), /正在使用/)
    release()
    await f.manager.download('qwen3'); await idle(f.manager)
    const qwen = await f.manager.acquire(['qwen3'])
    await assert.rejects(f.manager.download('hy-mt2-7b'), /正在使用/)
    qwen()
    await assert.rejects(f.manager.acquire(['qwen3', 'hy-mt2-7b']), /一个本地翻译模型/)
  } finally { await f.cleanup() }
})

test('unpublished model configuration versions are rejected without silent rewriting', async () => {
  const f = await fixture()
  try {
    await f.manager.setDownloadSource('hf-mirror')
    const configFile = path.join(f.root, 'local-models.json')
    const current = JSON.parse(await fs.readFile(configFile, 'utf8'))
    assert.equal(current.version, 1)
    const snapshots = [
      { version: 1, directory: current.directory, translation: 'app-default' },
      ...[2, 3, 4, 5].map(version => ({ ...current, version }))
    ]
    for (const document of snapshots) {
      const original = JSON.stringify(document)
      await fs.writeFile(configFile, original)
      const restarted = createLocalModelManager(f.root, { installer: f.installer })
      try {
        assert.ok((await restarted.snapshot()).configurationError)
        await assert.rejects(restarted.mode(), /设置损坏/)
        assert.equal(await fs.readFile(configFile, 'utf8'), original)
      } finally { await restarted.close() }
    }
  } finally { await f.cleanup() }
})

test('portable HY family selection does not enable unsupported inference', async () => {
  const f = await qwenFixture({ runtimeSupported: () => false })
  try {
    await f.manager.download('hy-mt2-7b'); await idle(f.manager)
    await f.manager.selectTranslationModel('hy-mt2-7b')
    assert.equal((await f.manager.snapshot()).translationModel, 'hy-mt2-7b')
    await assert.rejects(f.manager.setTranslation('local'), /Windows x64/)
    await assert.rejects(f.manager.translateText('はい'), /Windows x64/)
    assert.equal(await f.manager.mode(), 'app-default')
  } finally { await f.cleanup() }
})

test('HY download and precision selection require an explicit family change and retire the idle translator', async () => {
  const opened: Array<{ file: string; model: string | undefined }> = []
  let closed = 0
  const f = await qwenFixture({ inference: paths => {
    opened.push({ file: paths.translationModel, model: paths.translationModelId })
    return { translateText: async () => paths.translationModelId!, close: async () => { closed++ } }
  } })
  try {
    await assert.rejects(f.manager.selectTranslationModel('hy-mt2-7b'), /先下载/)
    await f.manager.download('qwen3'); await idle(f.manager)
    await f.manager.translateText('はい')
    await f.manager.download('hy-mt2-7b', 'hy-mt2-7b-q6_k'); await idle(f.manager)
    assert.equal((await f.manager.snapshot()).translationModel, 'qwen3')
    await assert.rejects(f.manager.selectTranslationModel('hy-mt2-7b'), /当前精度/)
    await f.manager.selectVariant('hy-mt2-7b', 'hy-mt2-7b-q6_k')
    assert.equal((await f.manager.snapshot()).translationModel, 'qwen3')
    await f.manager.selectTranslationModel('hy-mt2-7b')
    assert.equal(await f.manager.mode(), 'app-default')
    await f.manager.setTranslation('local')
    assert.equal(await f.manager.translateText('はい'), 'hy-mt2-7b')
    assert.equal(opened[1].model, 'hy-mt2-7b')
    assert.match(opened[1].file, /HY-MT2-7B-Q6_K\.gguf$/)
    assert.equal(closed, 1)
    await f.manager.selectTranslationModel('qwen3')
    assert.equal(closed, 2)
    assert.equal(await f.manager.translateText('はい'), 'qwen3')
    assert.equal(await f.manager.mode(), 'local')
  } finally { await f.cleanup() }
})

test('all three families and HY precision choices survive migration and restart without fallback after deletion', async () => {
  const f = await fixture()
  try {
    for (const model of ['kotoba', 'qwen3', 'hy-mt2-7b'] as const) {
      await f.manager.download(model); await idle(f.manager)
    }
    await f.manager.download('hy-mt2-7b', 'hy-mt2-7b-q8_0'); await idle(f.manager)
    await f.manager.selectVariant('hy-mt2-7b', 'hy-mt2-7b-q8_0')
    await f.manager.selectTranslationModel('hy-mt2-7b'); await f.manager.setTranslation('local')
    await f.manager.relocate(path.join(f.root, 'new-hy-models'))
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      const before = await restarted.snapshot()
      assert.equal(before.translationModel, 'hy-mt2-7b')
      assert.equal(before.translation, 'local')
      assert.equal(before.models.filter(model => model.id !== 'qwen3-asr').every(model => model.installed), true)
      const hy = before.models.find(model => model.id === 'hy-mt2-7b')!
      assert.equal(hy.selectedVariant, 'hy-mt2-7b-q8_0')
      assert.equal(hy.variants.filter(variant => variant.installed).length, 2)
      assert.equal(restarted.subtitleRuntime().paths().translationModelId, 'hy-mt2-7b')
      assert.match(restarted.subtitleRuntime().paths().translationModel, /HY-MT2-7B-Q8_0\.gguf$/)
      await removeKeepingUsage(restarted, 'hy-mt2-7b')
      assert.equal((await restarted.snapshot()).translationModel, 'hy-mt2-7b')
      assert.equal(await restarted.mode(), 'local')
      await assert.rejects(restarted.translateText('はい'), /未安装/)
      assert.equal(await restarted.subtitleRuntime().installed(), false)
      assert.equal((await restarted.snapshot()).models.filter(model => model.id !== 'hy-mt2-7b' && model.id !== 'qwen3-asr').every(model => model.installed), true)
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('HY subtitles do not require other translators and their leases protect the shared runtime against every family repair', async () => {
  const f = await fixture()
  try {
    for (const model of ['kotoba', 'hy-mt2-7b'] as const) { await f.manager.download(model); await idle(f.manager) }
    await f.manager.selectTranslationModel('hy-mt2-7b')
    assert.equal(await f.manager.subtitleRuntime().installed(), true)
    const release = await f.manager.acquireSubtitleRuntime()
    assert.deepEqual((await f.manager.snapshot()).models.filter(model => model.inUse).map(model => model.id), ['kotoba', 'hy-mt2-7b'])
    for (const model of ['qwen3', 'hy-mt2-7b'] as const) {
      await assert.rejects(f.manager.download(model), /正在使用/)
      await assert.rejects(f.manager.selectTranslationModel(model), /正在使用/)
    }
    await assert.rejects(f.manager.remove('hy-mt2-7b'), /正在使用/)
    await assert.rejects(f.manager.selectVariant('hy-mt2-7b', 'hy-mt2-7b-q6_k'), /正在使用/)
    await assert.rejects(f.manager.relocate(path.join(f.root, 'another')), /正在使用/)
    release(); release()
    await assert.rejects(f.manager.acquire(['qwen3', 'hy-mt2-7b']), /一个本地翻译模型/)
    assert.equal((await f.manager.snapshot()).models.some(model => model.inUse), false)
  } finally { await f.cleanup() }
})

test('current configuration rejects cross-family precision identities without silently routing to Qwen', async () => {
  const f = await fixture()
  try {
    await f.manager.setDownloadSource('official')
    const filename = path.join(f.root, 'local-models.json')
    const config = JSON.parse(await fs.readFile(filename, 'utf8'))
    config.selected['hy-mt2-7b'] = 'qwen3-q4_k_m'
    await fs.writeFile(filename, JSON.stringify(config))
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      await assert.rejects(restarted.mode(), /设置损坏/)
      await assert.rejects(restarted.translateText('はい'), /设置损坏/)
      await restarted.setTranslation('app-default')
      assert.equal(await restarted.mode(), 'app-default')
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('download source persists, covers repair and rejects changes during downloads', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.manager.snapshot()).downloadSource, 'official')
    await f.manager.setDownloadSource('hf-mirror')
    await f.manager.download('qwen3')
    await assert.rejects(f.manager.setDownloadSource('official'), /等待/)
    await idle(f.manager)
    assert.ok(f.downloadUrls.some(url => url.startsWith('https://hf-mirror.com/')))
    assert.ok(!f.downloadUrls.some(url => url.startsWith('https://huggingface.co/')))
    const reopened = createLocalModelManager(f.root, { installer: f.installer })
    try { assert.equal((await reopened.snapshot()).downloadSource, 'hf-mirror') }
    finally { await reopened.close() }
    f.downloadUrls.length = 0
    await f.manager.setDownloadSource('official')
    await f.manager.download('qwen3'); await idle(f.manager)
    assert.ok(f.downloadUrls.some(url => url.startsWith('https://huggingface.co/')))
    assert.equal((await f.manager.snapshot()).models.find(model => model.id === 'qwen3')?.installed, true)
  } finally { await f.cleanup() }
})

test('copy addresses use the selected download source and imports reject mismatched files without selecting variants', async () => {
  const f = await fixture()
  try {
    const official = await f.manager.downloadUrl('qwen3', 'qwen3-official-q8_0')
    assert.match(official, /^https:\/\/huggingface.co\/Qwen\//)
    await f.manager.setDownloadSource('hf-mirror')
    assert.equal(await f.manager.downloadUrl('qwen3', 'qwen3-official-q8_0'), official.replace('huggingface.co', 'hf-mirror.com'))
    const source = path.join(f.root, 'bad.gguf')
    await fs.writeFile(source, 'not a model')
    await assert.rejects(f.manager.importModel('qwen3', source, 'qwen3-official-q8_0'), /大小/)
    const state = await f.manager.snapshot()
    assert.equal(state.operation, null)
    assert.equal(state.models.find(model => model.id === 'qwen3')?.selectedVariant, 'qwen3-q4_k_m')
    assert.equal(f.attempts(), 0)
  } finally { await f.cleanup() }
})

test('imports cannot bypass the base environment prerequisite for either model type', async () => {
  let runtimeAvailable = false
  const f = await fixture({ runtimeAvailable: () => runtimeAvailable })
  try {
    const before = await f.manager.snapshot()
    const source = path.join(f.root, 'import.gguf')
    await fs.writeFile(source, 'not a model')
    for (const model of ['kotoba', 'qwen3', 'hy-mt2-7b'] as const) {
      await assert.rejects(f.manager.importModel(model, source), new RegExp(`请先安装${model === 'kotoba' ? '语音' : '文本'}模型的基础运行环境`))
    }
    assert.equal((await f.manager.snapshot()).operation, null)
    assert.deepEqual((await f.manager.snapshot()).usage, before.usage)
    assert.equal(await fs.readFile(source, 'utf8'), 'not a model')
    runtimeAvailable = true
    await f.manager.detectDevices()
    await assert.rejects(f.manager.importModel('qwen3', source), /文件大小与所选模型精度不匹配/)
    assert.equal((await f.manager.snapshot()).operation, null)
    assert.equal(f.attempts(), 0)
  } finally { await f.cleanup() }
})

test('purpose bindings keep separate exact translator variants across restart and freeze active subtitle paths', async () => {
  const opened: string[] = []
  const f = await qwenFixture({ inference: paths => {
    opened.push(paths.translationModel)
    return { translateText: async () => '译文', close: async () => {} }
  } })
  try {
    for (const model of ['kotoba', 'qwen3'] as const) { await f.manager.download(model); await idle(f.manager) }
    await f.manager.download('qwen3', 'qwen3-official-q8_0'); await idle(f.manager)
    const initial = await f.manager.snapshot()
    const usage = { ...initial.usage, textTranslation: { mode: 'local' as const, model: 'qwen3' as const, variant: 'qwen3-official-q8_0' } }
    await f.manager.setUsage(usage, initial.revision)
    const subtitlePath = f.manager.subtitleRuntime().paths().translationModel
    assert.match(subtitlePath, /Qwen_Qwen3-1\.7B-Q4_K_M\.gguf$/)
    await f.manager.translateText('はい')
    assert.match(opened[0], /Q8_0\.gguf$/)
    const release = await f.manager.acquireSubtitleRuntime()
    const active = await f.manager.snapshot(), variants = active.models.find(model => model.id === 'qwen3')!.variants
    assert.equal(variants.find(variant => variant.id === 'qwen3-q4_k_m')!.inUse, true)
    assert.equal(variants.find(variant => variant.id === 'qwen3-official-q8_0')!.inUse, false)
    assert.deepEqual(variants.find(variant => variant.id === 'qwen3-q4_k_m')!.references, ['AI 字幕 · 文本翻译'])
    assert.deepEqual(variants.find(variant => variant.id === 'qwen3-official-q8_0')!.references, ['文本翻译'])
    await f.manager.setUsage({ ...usage, textTranslation: { mode: 'local', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q6_k' } }, active.revision)
    assert.equal(f.manager.subtitleRuntime().paths().translationModel, subtitlePath)
    await assert.rejects(f.manager.setUsage({ ...usage, subtitleRecognition: { model: 'kotoba', variant: 'kotoba-f16' } }), /正在使用/)
    await assert.rejects(f.manager.setUsage({ ...usage, subtitleTranslation: { model: 'qwen3', variant: 'qwen3-official-q8_0' } }), /正在使用/)
    await f.manager.remove('qwen3', 'qwen3-official-q8_0')
    await assert.rejects(f.manager.remove('qwen3', 'qwen3-q4_k_m'), /正在使用/)
    await assert.rejects(f.manager.download('hy-mt2-7b'), /正在使用/)
    release()
    await f.manager.remove('qwen3', 'qwen3-q4_k_m')
    const saved = await f.manager.snapshot()
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      assert.deepEqual((await restarted.snapshot()).usage, saved.usage)
      assert.equal((await restarted.snapshot()).revision, saved.revision)
      await assert.rejects(restarted.translateText('はい'), /未安装/)
      assert.equal(await restarted.mode(), 'local')
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('atomic purpose saves reject stale drafts and mismatched variants while permitting missing files', async () => {
  const f = await fixture()
  try {
    const initial = await f.manager.snapshot()
    const usage = { ...initial.usage, subtitleTranslation: { model: 'hy-mt2-7b' as const, variant: 'hy-mt2-7b-q8_0' } }
    await f.manager.setUsage(usage, initial.revision)
    const saved = await f.manager.snapshot()
    assert.notEqual(saved.revision, initial.revision)
    assert.equal(saved.models.find(model => model.id === 'hy-mt2-7b')!.variants.find(variant => variant.id === 'hy-mt2-7b-q8_0')!.readiness, 'missing-model')
    await assert.rejects(f.manager.setUsage(initial.usage, initial.revision), /已更新/)
    await assert.rejects(f.manager.setUsage({ ...usage, subtitleTranslation: { model: 'qwen3', variant: 'hy-mt2-7b-q8_0' } }), /不匹配/)
    assert.deepEqual((await f.manager.snapshot()).usage, saved.usage)
    const file = JSON.parse(await fs.readFile(path.join(f.root, 'local-models.json'), 'utf8'))
    assert.equal(file.version, 1); assert.deepEqual(file.usage, saved.usage)
    assert.equal('translation' in file, false); assert.equal('translationModel' in file, false)
    assert.equal((await f.manager.snapshot()).operation, null)
  } finally { await f.cleanup() }
})

test('current configuration preserves mirror source, directory, weights and purpose bindings without rewriting on startup', async () => {
  const f = await qwenFixture()
  try {
    for (const model of ['kotoba', 'qwen3'] as const) { await f.manager.download(model); await idle(f.manager) }
    await f.manager.setDownloadSource('hf-mirror')
    await f.manager.setTranslation('local')
    const before = await f.manager.snapshot(), runtime = f.installer(before.directory)
    const filename = `${runtime.paths().translationModel}.ready`, contents = await fs.readFile(filename, 'utf8')
    const selected = Object.fromEntries(before.models.map(model => [model.id, model.selectedVariant]))
    const configFile = path.join(f.root, 'local-models.json')
    const original = await fs.readFile(configFile, 'utf8')
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      const after = await restarted.snapshot()
      assert.equal(after.downloadSource, 'hf-mirror'); assert.equal(after.directory, before.directory)
      assert.deepEqual(after.models.map(model => model.selectedVariant), before.models.map(model => model.selectedVariant))
      assert.deepEqual(after.usage.subtitleRecognition, { model: 'kotoba', variant: selected.kotoba })
      assert.deepEqual(after.usage.subtitleTranslation, { model: 'qwen3', variant: selected.qwen3 })
      assert.deepEqual(after.usage.textTranslation, { mode: 'local', model: 'qwen3', variant: selected.qwen3 })
      assert.equal(await fs.readFile(filename, 'utf8'), contents)
      assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).version, 1)
      assert.equal(await fs.readFile(configFile, 'utf8'), original)
      assert.equal(await restarted.subtitleRuntime().installed(), true)
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('damaged purpose references never reach the snapshot and explicit recovery preserves valid storage metadata', async () => {
  const f = await fixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager)
    await f.manager.setDownloadSource('hf-mirror')
    await f.manager.relocate(path.join(f.root, 'custom-models'))
    const configFile = path.join(f.root, 'local-models.json'), config = JSON.parse(await fs.readFile(configFile, 'utf8'))
    config.usage.subtitleTranslation = { model: 'qwen3', variant: 'hy-mt2-7b-q8_0' }
    const damaged = JSON.stringify(config)
    await fs.writeFile(configFile, damaged)
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      const state = await restarted.snapshot()
      assert.match(state.configurationError ?? '', /重新保存/)
      assert.equal(state.directory, config.directory); assert.equal(state.downloadSource, 'hf-mirror')
      assert.deepEqual(state.usage.subtitleTranslation, { model: 'hy-mt2-7b', variant: config.selected['hy-mt2-7b'] })
      assert.equal(await fs.readFile(configFile, 'utf8'), damaged, 'bad configuration must not be silently overwritten')
      await assert.rejects(restarted.acquireSubtitleRuntime(), /设置损坏/)
      await restarted.setUsage(state.usage, state.revision)
      const recovered = await restarted.snapshot()
      assert.equal(recovered.configurationError, null)
      assert.equal(recovered.directory, config.directory)
      assert.equal(recovered.models.find(model => model.id === 'qwen3')!.variants.find(variant => variant.id === config.selected.qwen3)!.installed, true)
      assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')).usage, recovered.usage)
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('readiness distinguishes downloaded weights, missing runtime and unsupported inference', async () => {
  for (const supported of [true, false]) {
    let runtimeAvailable = true
    const f = await fixture({ runtimeSupported: () => supported, runtimeAvailable: () => runtimeAvailable })
    try {
      await f.manager.download('qwen3'); await idle(f.manager)
      runtimeAvailable = false
      await f.manager.detectDevices()
      const variant = (await f.manager.snapshot()).models.find(model => model.id === 'qwen3')!.variants.find(item => item.id === 'qwen3-q4_k_m')!
      assert.equal(variant.installed, true)
      assert.equal(variant.ready, false)
      assert.equal(variant.readiness, supported ? 'missing-runtime' : 'unsupported')
    } finally { await f.cleanup() }
  }
})

test('active text translation rejects purpose changes and shared runtime repair until its exact lease ends', async () => {
  let resume!: () => void, entered!: () => void
  const running = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { resume = resolve })
  const f = await qwenFixture({ inference: () => ({ translateText: async () => { entered(); await gate; return '译文' }, close: async () => {} }) })
  try {
    await f.manager.download('qwen3'); await idle(f.manager)
    const pending = f.manager.translateText('はい')
    await running
    const state = await f.manager.snapshot()
    await assert.rejects(f.manager.setUsage({ ...state.usage, textTranslation: { ...state.usage.textTranslation, variant: 'qwen3-official-q8_0' } }), /正在使用/)
    await assert.rejects(f.manager.download('hy-mt2-7b'), /正在使用/)
    assert.equal(state.models.find(model => model.id === 'qwen3')!.variants.find(variant => variant.id === 'qwen3-q4_k_m')!.inUse, true)
    resume(); assert.equal(await pending, '译文')
    assert.equal((await f.manager.snapshot()).models.some(model => model.inUse), false)
  } finally { resume(); await f.cleanup() }
})
