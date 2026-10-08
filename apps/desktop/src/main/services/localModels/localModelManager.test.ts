import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createLocalModelManager } from './localModelManager'
import { createAiRuntimeInstaller } from '../../player/aiSubtitles/runtimeInstaller'
import { createOfflineSubtitleInference } from '../../player/aiSubtitles/offlineInference'

async function fixture(options: { inference?: typeof createOfflineSubtitleInference; runtimeSupported?: () => boolean; runtimeAvailable?: () => boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-local-models-'))
  let fail = false, attempts = 0
  const downloadUrls: string[] = []
  const installer: typeof createAiRuntimeInstaller = (directory, download, assets) => {
    const base = createAiRuntimeInstaller(directory, download, assets)
    const modelFile = (id: string): string => `${id === 'kotoba' ? base.paths().kotoba : base.paths().translationModel}.ready`
    const weights = (ids: readonly string[]) => ids.filter(id => id === 'kotoba' || id === 'translation-model')
    const assetsInstalled = async (ids: readonly string[]) => (!ids.some(id => id !== 'kotoba' && id !== 'translation-model') || options.runtimeAvailable?.() !== false)
      && (await Promise.all(weights(ids).map(id => fs.access(modelFile(id)).then(() => true, () => false)))).every(Boolean)
    return { ...base,
      installed: () => assetsInstalled(['kotoba', 'translation-model']), assetsInstalled,
      removeAsset: async id => { await fs.rm(modelFile(id), { force: true }) },
      install: async (signal, progress, ids = []) => {
        downloadUrls.push(...(assets ?? []).map(asset => asset.url))
        attempts++; await delay(20, undefined, { signal })
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
  const manager = createLocalModelManager(root, { installer, runtimeSupported: () => true, ...options })
  return { root, manager, installer, downloadUrls, setFail: (value: boolean) => { fail = value }, attempts: () => attempts,
    cleanup: async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }) } }
}
async function idle(manager: ReturnType<typeof createLocalModelManager>): Promise<void> {
  for (let count = 0; count < 200; count++) { if (!(await manager.snapshot()).operation) return; await delay(5) }
  assert.fail('model operation did not settle')
}
async function removeAfterUnreferencing(manager: ReturnType<typeof createLocalModelManager>, model: 'qwen3' | 'hy-mt2-7b' | 'index-translate-9b'): Promise<void> {
  const state = await manager.snapshot(), family = state.models.find(item => item.id === model)!
  const variant = family.selectedVariant
  await assert.rejects(manager.remove(model, variant), /引用/)
  const replacement = family.variants.find(item => item.id !== variant && !item.installed)!
  const usage = structuredClone(state.usage)
  for (const ref of Object.values(usage)) if (ref.model === model && ref.variant === variant) ref.variant = replacement.id
  await manager.setUsage(usage, state.revision)
  await manager.remove(model, variant)
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
test('runtime leases and configured purposes guard deletion; missing weights never enable online fallback', async () => {
  const f = await fixture()
  try {
    await f.manager.download('qwen3'); await idle(f.manager); await f.manager.setTranslation('local')
    const release = await f.manager.acquire(['qwen3'])
    await assert.rejects(f.manager.remove('qwen3'), /正在使用/)
    await assert.rejects(f.manager.relocate(path.join(f.root, 'elsewhere')), /正在使用/)
    release(); release()
    await removeAfterUnreferencing(f.manager, 'qwen3')
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
    assert.equal(await fs.readFile(`${f.installer(destination).paths().translationModel}.ready`, 'utf8'), 'translation-model')
    assert.equal(await fs.access(f.installer(old).directory).then(() => true, () => false), false)
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    const canonical = await fs.realpath(destination)
    assert.equal((await restarted.snapshot()).directory, canonical)
    assert.equal(await restarted.mode(), 'local'); await restarted.close()
    const collision = path.join(f.root, 'collision')
    await fs.mkdir(f.installer(collision).directory, { recursive: true })
    await assert.rejects(f.manager.relocate(collision), /已有/)
    assert.equal((await f.manager.snapshot()).directory, canonical)
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
  const f = await fixture()
  try {
    const model = () => f.manager.snapshot().then(state => state.models.find(item => item.id === 'qwen3')!)
    await assert.rejects(f.manager.selectVariant('qwen3', 'qwen3-q8_0'), /先下载/)
    await f.manager.download('qwen3'); await idle(f.manager)
    await f.manager.download('qwen3', 'qwen3-q8_0'); await idle(f.manager)
    assert.equal((await model()).selectedVariant, 'qwen3-q4_k_m')
    assert.equal((await model()).variants.filter(item => item.installed).length, 2)
    await f.manager.selectVariant('qwen3', 'qwen3-q8_0')
    await f.manager.setTranslation('local')
    const release = await f.manager.acquire(['qwen3'])
    await assert.rejects(f.manager.selectVariant('qwen3', 'qwen3-q4_k_m'), /正在使用/)
    await f.manager.remove('qwen3', 'qwen3-q4_k_m')
    release()
    await f.manager.relocate(path.join(f.root, 'new-models'))
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      const state = await restarted.snapshot(), qwen = state.models.find(item => item.id === 'qwen3')!
      assert.equal(qwen.selectedVariant, 'qwen3-q8_0')
      assert.equal(qwen.variants.filter(item => item.installed).length, 1)
      assert.equal(await restarted.mode(), 'local')
      await restarted.remove('qwen3', 'qwen3-q4_k_m')
      const after = (await restarted.snapshot()).models.find(item => item.id === 'qwen3')!
      assert.equal(after.installed, true)
      assert.equal(after.selectedVariant, 'qwen3-q8_0')
      assert.deepEqual(after.variants.filter(item => item.installed).map(item => item.id), ['qwen3-q8_0'])
      await removeAfterUnreferencing(restarted, 'qwen3')
      assert.equal(await restarted.mode(), 'local')
      await assert.rejects(restarted.translateText('日本語'), /未安装/)
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('legacy configuration retains the exact original precision and invalid variant identities cannot change it', async () => {
  const f = await fixture()
  try {
    const directory = (await f.manager.snapshot()).directory
    await fs.writeFile(path.join(f.root, 'local-models.json'), JSON.stringify({ version: 1, directory, translation: 'app-default' }))
    const restarted = createLocalModelManager(f.root, { installer: f.installer })
    try {
      assert.deepEqual((await restarted.snapshot()).models.map(item => item.selectedVariant), ['qwen3-q4_k_m', 'kotoba-q5_0', 'hy-mt2-7b-q4_k_m', 'index-translate-9b-q4_k_m'])
      await assert.rejects(restarted.selectVariant('qwen3', 'kotoba-q5_0'), /不匹配/)
      await assert.rejects(restarted.download('kotoba', '../custom-file'), /不匹配/)
      await assert.rejects(restarted.remove('qwen3', 'missing-precision'), /不匹配/)
      assert.equal((await restarted.snapshot()).operation, null)
    } finally { await restarted.close() }
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
  const f = await fixture({ inference: paths => {
    opened.push(paths.translationModel)
    return { translateText: async () => '译文', close: async () => { closed++ },
      probe: async () => { throw new Error('unexpected subtitle probe') },
      recognize: async () => { throw new Error('unexpected subtitle recognition') },
      translate: async () => { throw new Error('unexpected subtitle translation') } }
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
  const f = await fixture({ runtimeSupported: () => false })
  try {
    await f.manager.download('qwen3', 'qwen3-q8_0'); await idle(f.manager)
    await f.manager.selectVariant('qwen3', 'qwen3-q8_0')
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
  const f = await fixture({ inference: paths => {
    opened.push({ file: paths.translationModel, model: paths.translationModelId })
    return { translateText: async () => paths.translationModelId!, close: async () => { closed++ },
      probe: async () => { throw new Error('unexpected probe') }, recognize: async () => [], translate: async cues => cues }
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
      await removeAfterUnreferencing(restarted, 'hy-mt2-7b')
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

test('v2 Qwen settings migrate exact shared purpose bindings to v5 without changing mode or files', async () => {
  const f = await fixture()
  try {
    const directory = (await f.manager.snapshot()).directory
    const original = JSON.stringify({ version: 2, directory, translation: 'local', selected: { kotoba: 'kotoba-f16', qwen3: 'qwen3-official-q8_0' } })
    const configFile = path.join(f.root, 'local-models.json')
    await fs.writeFile(configFile, original)
    const restarted = createLocalModelManager(f.root, { installer: f.installer })
    try {
      const state = await restarted.snapshot()
      assert.equal(state.translationModel, 'qwen3')
      assert.equal(state.translation, 'local')
      assert.equal(state.models.find(model => model.id === 'qwen3')!.selectedVariant, 'qwen3-official-q8_0')
      assert.equal(state.models.find(model => model.id === 'kotoba')!.selectedVariant, 'kotoba-f16')
      assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).version, 5)
      assert.deepEqual(state.usage.subtitleTranslation, { model: 'qwen3', variant: 'qwen3-official-q8_0' })
      assert.deepEqual(state.usage.textTranslation, { mode: 'local', model: 'qwen3', variant: 'qwen3-official-q8_0' })
      await restarted.setTranslation('app-default')
      const saved = JSON.parse(await fs.readFile(configFile, 'utf8'))
      assert.equal(saved.version, 5)
      assert.equal(saved.translationModel, 'qwen3')
      assert.equal(saved.selected.qwen3, 'qwen3-official-q8_0')
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('portable HY family selection does not enable unsupported inference', async () => {
  const f = await fixture({ runtimeSupported: () => false })
  try {
    await f.manager.download('hy-mt2-7b'); await idle(f.manager)
    await f.manager.selectTranslationModel('hy-mt2-7b')
    assert.equal((await f.manager.snapshot()).translationModel, 'hy-mt2-7b')
    await assert.rejects(f.manager.setTranslation('local'), /Windows x64/)
    await assert.rejects(f.manager.translateText('はい'), /Windows x64/)
    assert.equal(await f.manager.mode(), 'app-default')
  } finally { await f.cleanup() }
})

test('Index download and precision selection require an explicit family change and retire the idle translator', async () => {
  const opened: Array<{ file: string; model: string | undefined }> = []
  let closed = 0
  const f = await fixture({ inference: paths => {
    opened.push({ file: paths.translationModel, model: paths.translationModelId })
    return { translateText: async () => paths.translationModelId!, close: async () => { closed++ },
      probe: async () => { throw new Error('unexpected probe') }, recognize: async () => [], translate: async cues => cues }
  } })
  try {
    await assert.rejects(f.manager.selectTranslationModel('index-translate-9b'), /先下载/)
    await f.manager.download('qwen3'); await idle(f.manager)
    await f.manager.translateText('はい')
    await f.manager.download('index-translate-9b', 'index-translate-9b-q8_0'); await idle(f.manager)
    assert.equal((await f.manager.snapshot()).translationModel, 'qwen3')
    await assert.rejects(f.manager.selectTranslationModel('index-translate-9b'), /当前精度/)
    await f.manager.selectVariant('index-translate-9b', 'index-translate-9b-q8_0')
    assert.equal((await f.manager.snapshot()).translationModel, 'qwen3')
    await f.manager.selectTranslationModel('index-translate-9b')
    assert.equal(await f.manager.mode(), 'app-default')
    await f.manager.setTranslation('local')
    assert.equal(await f.manager.translateText('はい'), 'index-translate-9b')
    assert.equal(opened[1].model, 'index-translate-9b')
    assert.match(opened[1].file, /Index-Translate-9B\.Q8_0\.gguf$/)
    assert.equal(closed, 1)
    await f.manager.selectTranslationModel('qwen3')
    assert.equal(closed, 2)
    assert.equal(await f.manager.translateText('はい'), 'qwen3')
    assert.equal(await f.manager.mode(), 'local')
  } finally { await f.cleanup() }
})

test('all four families and Index precision choices survive migration and restart without fallback after deletion', async () => {
  const f = await fixture()
  try {
    for (const model of ['kotoba', 'qwen3', 'hy-mt2-7b', 'index-translate-9b'] as const) {
      await f.manager.download(model); await idle(f.manager)
    }
    await f.manager.download('index-translate-9b', 'index-translate-9b-f16'); await idle(f.manager)
    await f.manager.selectVariant('index-translate-9b', 'index-translate-9b-f16')
    await f.manager.selectTranslationModel('index-translate-9b'); await f.manager.setTranslation('local')
    await f.manager.relocate(path.join(f.root, 'new-index-models'))
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      const before = await restarted.snapshot()
      assert.equal(before.translationModel, 'index-translate-9b')
      assert.equal(before.translation, 'local')
      assert.equal(before.models.every(model => model.installed), true)
      const index = before.models.find(model => model.id === 'index-translate-9b')!
      assert.equal(index.selectedVariant, 'index-translate-9b-f16')
      assert.equal(index.variants.filter(variant => variant.installed).length, 2)
      assert.equal(restarted.subtitleRuntime().paths().translationModelId, 'index-translate-9b')
      assert.match(restarted.subtitleRuntime().paths().translationModel, /Index-Translate-9B\.f16\.gguf$/)
      await removeAfterUnreferencing(restarted, 'index-translate-9b')
      assert.equal((await restarted.snapshot()).translationModel, 'index-translate-9b')
      assert.equal(await restarted.mode(), 'local')
      await assert.rejects(restarted.translateText('はい'), /未安装/)
      assert.equal(await restarted.subtitleRuntime().installed(), false)
      assert.equal((await restarted.snapshot()).models.filter(model => model.id !== 'index-translate-9b').every(model => model.installed), true)
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('Index subtitles do not require other translators and their leases protect the shared runtime against every family repair', async () => {
  const f = await fixture()
  try {
    for (const model of ['kotoba', 'index-translate-9b'] as const) { await f.manager.download(model); await idle(f.manager) }
    await f.manager.selectTranslationModel('index-translate-9b')
    assert.equal(await f.manager.subtitleRuntime().installed(), true)
    const release = await f.manager.acquireSubtitleRuntime()
    assert.deepEqual((await f.manager.snapshot()).models.filter(model => model.inUse).map(model => model.id), ['kotoba', 'index-translate-9b'])
    for (const model of ['qwen3', 'hy-mt2-7b', 'index-translate-9b'] as const) {
      await assert.rejects(f.manager.download(model), /正在使用/)
      await assert.rejects(f.manager.selectTranslationModel(model), /正在使用/)
    }
    await assert.rejects(f.manager.remove('index-translate-9b'), /正在使用/)
    await assert.rejects(f.manager.selectVariant('index-translate-9b', 'index-translate-9b-q8_0'), /正在使用/)
    await assert.rejects(f.manager.relocate(path.join(f.root, 'another')), /正在使用/)
    release(); release()
    await assert.rejects(f.manager.acquire(['hy-mt2-7b', 'index-translate-9b']), /一个本地翻译模型/)
    assert.equal((await f.manager.snapshot()).models.some(model => model.inUse), false)
  } finally { await f.cleanup() }
})

test('v3 HY settings migrate exact shared purpose bindings to v5 while preserving other family selections', async () => {
  const f = await fixture()
  try {
    const directory = (await f.manager.snapshot()).directory
    const original = JSON.stringify({ version: 3, directory, translation: 'local', translationModel: 'hy-mt2-7b',
      selected: { kotoba: 'kotoba-f16', qwen3: 'qwen3-official-q8_0', 'hy-mt2-7b': 'hy-mt2-7b-q6_k' } })
    const configFile = path.join(f.root, 'local-models.json')
    await fs.writeFile(configFile, original)
    const restarted = createLocalModelManager(f.root, { installer: f.installer })
    try {
      const state = await restarted.snapshot()
      assert.equal(state.directory, directory)
      assert.equal(state.translationModel, 'hy-mt2-7b')
      assert.equal(state.translation, 'local')
      assert.deepEqual(state.models.map(model => model.selectedVariant), ['qwen3-official-q8_0', 'kotoba-f16', 'hy-mt2-7b-q6_k', 'index-translate-9b-q4_k_m'])
      assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).version, 5)
      assert.deepEqual(state.usage.subtitleTranslation, { model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q6_k' })
      assert.deepEqual(state.usage.textTranslation, { mode: 'local', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q6_k' })
      await restarted.setTranslation('app-default')
      const saved = JSON.parse(await fs.readFile(configFile, 'utf8'))
      assert.equal(saved.version, 5)
      assert.equal(saved.translationModel, 'hy-mt2-7b')
      assert.equal(saved.selected['hy-mt2-7b'], 'hy-mt2-7b-q6_k')
      assert.equal(saved.selected['index-translate-9b'], 'index-translate-9b-q4_k_m')
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('v4 rejects cross-family precision identities without silently routing to Qwen', async () => {
  const f = await fixture()
  try {
    const directory = (await f.manager.snapshot()).directory
    await fs.writeFile(path.join(f.root, 'local-models.json'), JSON.stringify({ version: 4, directory, translation: 'local',
      translationModel: 'index-translate-9b', selected: { kotoba: 'kotoba-q5_0', qwen3: 'qwen3-q4_k_m',
        'hy-mt2-7b': 'hy-mt2-7b-q4_k_m', 'index-translate-9b': 'hy-mt2-7b-q4_k_m' } }))
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      await assert.rejects(restarted.mode(), /设置损坏/)
      await assert.rejects(restarted.translateText('はい'), /设置损坏/)
      await restarted.setTranslation('app-default')
      assert.equal(await restarted.mode(), 'app-default')
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('portable Index weights and family selection cannot enable inference on an unsupported platform', async () => {
  const f = await fixture({ runtimeSupported: () => false })
  try {
    await f.manager.download('index-translate-9b'); await idle(f.manager)
    await f.manager.selectTranslationModel('index-translate-9b')
    assert.equal((await f.manager.snapshot()).translationModel, 'index-translate-9b')
    await assert.rejects(f.manager.setTranslation('local'), /Windows x64/)
    await assert.rejects(f.manager.translateText('はい'), /Windows x64/)
    assert.equal(await f.manager.mode(), 'app-default')
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

test('purpose bindings keep separate exact translator variants across restart and freeze active subtitle paths', async () => {
  const opened: string[] = []
  const f = await fixture({ inference: paths => {
    opened.push(paths.translationModel)
    return { translateText: async () => '译文', close: async () => {}, probe: async () => { throw new Error('unexpected probe') },
      recognize: async () => [], translate: async cues => cues }
  } })
  try {
    for (const model of ['kotoba', 'qwen3'] as const) { await f.manager.download(model); await idle(f.manager) }
    await f.manager.download('qwen3', 'qwen3-official-q8_0'); await idle(f.manager)
    const initial = await f.manager.snapshot()
    const usage = { ...initial.usage, textTranslation: { mode: 'local' as const, model: 'qwen3' as const, variant: 'qwen3-official-q8_0' } }
    await f.manager.setUsage(usage, initial.revision)
    const subtitlePath = f.manager.subtitleRuntime().paths().translationModel
    assert.match(subtitlePath, /qwen3-q4\.gguf$/)
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
    await assert.rejects(f.manager.download('index-translate-9b'), /正在使用/)
    release()
    await assert.rejects(f.manager.remove('qwen3', 'qwen3-q4_k_m'), /引用/)
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
    const usage = { ...initial.usage, subtitleTranslation: { model: 'index-translate-9b' as const, variant: 'index-translate-9b-f16' } }
    await f.manager.setUsage(usage, initial.revision)
    const saved = await f.manager.snapshot()
    assert.notEqual(saved.revision, initial.revision)
    assert.equal(saved.models.find(model => model.id === 'index-translate-9b')!.variants.find(variant => variant.id === 'index-translate-9b-f16')!.readiness, 'missing-model')
    await assert.rejects(f.manager.setUsage(initial.usage, initial.revision), /已更新/)
    await assert.rejects(f.manager.setUsage({ ...usage, subtitleTranslation: { model: 'qwen3', variant: 'index-translate-9b-f16' } }), /不匹配/)
    assert.deepEqual((await f.manager.snapshot()).usage, saved.usage)
    const file = JSON.parse(await fs.readFile(path.join(f.root, 'local-models.json'), 'utf8'))
    assert.equal(file.version, 5); assert.deepEqual(file.usage, saved.usage)
    assert.equal((await f.manager.snapshot()).operation, null)
  } finally { await f.cleanup() }
})

test('v4 migration preserves mirror source, directory, weights and both formerly shared translation bindings', async () => {
  const f = await fixture()
  try {
    for (const model of ['kotoba', 'qwen3'] as const) { await f.manager.download(model); await idle(f.manager) }
    const before = await f.manager.snapshot(), runtime = f.installer(before.directory)
    const filename = `${runtime.paths().translationModel}.ready`, contents = await fs.readFile(filename, 'utf8')
    const selected = Object.fromEntries(before.models.map(model => [model.id, model.selectedVariant]))
    const configFile = path.join(f.root, 'local-models.json')
    await fs.writeFile(configFile, JSON.stringify({ version: 4, directory: before.directory, translation: 'local',
      translationModel: 'qwen3', downloadSource: 'hf-mirror', selected }))
    const restarted = createLocalModelManager(f.root, { installer: f.installer, runtimeSupported: () => true })
    try {
      const after = await restarted.snapshot()
      assert.equal(after.downloadSource, 'hf-mirror'); assert.equal(after.directory, before.directory)
      assert.deepEqual(after.models.map(model => model.selectedVariant), before.models.map(model => model.selectedVariant))
      assert.deepEqual(after.usage.subtitleRecognition, { model: 'kotoba', variant: selected.kotoba })
      assert.deepEqual(after.usage.subtitleTranslation, { model: 'qwen3', variant: selected.qwen3 })
      assert.deepEqual(after.usage.textTranslation, { mode: 'local', model: 'qwen3', variant: selected.qwen3 })
      assert.equal(await fs.readFile(filename, 'utf8'), contents)
      assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).version, 5)
      assert.equal(await restarted.subtitleRuntime().installed(), true)
    } finally { await restarted.close() }
  } finally { await f.cleanup() }
})

test('damaged v5 purpose references never reach the snapshot and explicit recovery preserves valid storage metadata', async () => {
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
      assert.deepEqual(state.usage.subtitleTranslation, { model: 'qwen3', variant: config.selected.qwen3 })
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
    const f = await fixture({ runtimeSupported: () => supported, runtimeAvailable: () => false })
    try {
      await f.manager.download('qwen3'); await idle(f.manager)
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
  const f = await fixture({ inference: () => ({ translateText: async () => { entered(); await gate; return '译文' }, close: async () => {},
    probe: async () => { throw new Error('unexpected probe') }, recognize: async () => [], translate: async cues => cues }) })
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
