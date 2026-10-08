import fs from 'node:fs/promises'
import { importModelFile } from './importModelFile'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { LOCAL_MODEL_DOWNLOAD_SOURCES, type LocalModelDownloadSource, LOCAL_MODEL_IDS, LOCAL_TRANSLATION_MODEL_IDS, type LocalModelId, type LocalModelSnapshot,
  type LocalTranslationMode, type LocalTranslationModelId } from '@shared/desktop/localModels'
import type { LocalModelRef, LocalModelUsage, LocalModelReadiness } from '@shared/desktop/localModels'
import { createAiRuntimeInstaller, aiSubtitleSupported } from '../../player/aiSubtitles/runtimeInstaller'
import { AI_SUBTITLE_RUNTIME_VERSION, AI_RUNTIME_PLATFORM_MESSAGE } from '../../player/aiSubtitles/runtimeManifest'
import { AI_RUNTIME_LICENSES } from '../../player/aiSubtitles/runtimeLicenses'
import { atomicWrite } from '../../player/aiSubtitles/subtitleCache'
import { createOfflineSubtitleInference } from '../../player/aiSubtitles/offlineInference'
import { DEFAULT_LOCAL_MODEL_VARIANTS, LOCAL_MODEL_DEFINITIONS, LOCAL_MODEL_VARIANTS, localModelAssets, localModelVariant } from './modelCatalog'
const configFields = { directory: z.string().min(1), translation: z.enum(['app-default', 'local']) }
const selectedSchema = z.object({ kotoba: z.string(), qwen3: z.string(), 'hy-mt2-7b': z.string(), 'index-translate-9b': z.string() }).strict()
const translationRefSchema = z.object({ model: z.enum(LOCAL_TRANSLATION_MODEL_IDS), variant: z.string().min(1) }).strict()
const usageSchema = z.object({
  subtitleRecognition: z.object({ model: z.literal('kotoba'), variant: z.string().min(1) }).strict(),
  subtitleTranslation: translationRefSchema,
  textTranslation: translationRefSchema.extend({ mode: z.enum(['app-default', 'local']) }).strict()
}).strict()
const configSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...configFields }).strict(),
  z.object({ version: z.literal(2), ...configFields, selected: z.object({ kotoba: z.string(), qwen3: z.string() }).strict() }).strict(),
  z.object({ version: z.literal(3), ...configFields, translationModel: z.enum(['qwen3', 'hy-mt2-7b']),
    selected: z.object({ kotoba: z.string(), qwen3: z.string(), 'hy-mt2-7b': z.string() }).strict() }).strict(),
  z.object({ version: z.literal(4), ...configFields, downloadSource: z.enum(LOCAL_MODEL_DOWNLOAD_SOURCES).default('official'), translationModel: z.enum(LOCAL_TRANSLATION_MODEL_IDS),
    selected: selectedSchema }).strict(),
  z.object({ version: z.literal(5), ...configFields, downloadSource: z.enum(LOCAL_MODEL_DOWNLOAD_SOURCES), translationModel: z.enum(LOCAL_TRANSLATION_MODEL_IDS),
    selected: selectedSchema, usage: usageSchema, revision: z.string().min(1) }).strict()
])
export async function localModelFileHash(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function files(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('模型目录包含不支持的链接或文件')
    return entry.isDirectory() ? files(filename) : [filename]
  }))).flat()
}
export function createLocalModelManager(userData: string, options: {
  installer?: typeof createAiRuntimeInstaller
  inference?: typeof createOfflineSubtitleInference
  runtimeSupported?: typeof aiSubtitleSupported
  bundleRoot?: string
} = {}) {
  const defaultDirectory = path.join(userData, 'ai-subtitles', 'models')
  const configFile = path.join(userData, 'local-models.json')
  let directory = defaultDirectory, translation: LocalTranslationMode = 'app-default'
  let downloadSource: LocalModelDownloadSource = 'official'
  let translationModel: LocalTranslationModelId = 'qwen3'
  let selected = { ...DEFAULT_LOCAL_MODEL_VARIANTS }
  let usage: LocalModelUsage = {
    subtitleRecognition: { model: 'kotoba', variant: selected.kotoba },
    subtitleTranslation: { model: 'qwen3', variant: selected.qwen3 },
    textTranslation: { mode: 'app-default', model: 'qwen3', variant: selected.qwen3 }
  }
  let revision: string = randomUUID()
  let configInvalid = false
  let operation: LocalModelSnapshot['operation'] = null, activeModel: LocalModelId | null = null
  let activeVariant: string | null = null
  let downloadBytes = 0, downloadTotal = 0, downloadLabel: string | null = null, error: string | null = null
  let controller: AbortController | null = null, pending: Promise<void> | null = null
  let closed = false, idle: ReturnType<typeof setTimeout> | null = null
  let engine: ReturnType<typeof createOfflineSubtitleInference> | null = null
  let engineVariant: string | null = null
  const counts = Object.fromEntries(LOCAL_MODEL_IDS.map(id => [id, 0])) as Record<LocalModelId, number>
  const installed = Object.fromEntries(LOCAL_MODEL_IDS.map(id => [id, false])) as Record<LocalModelId, boolean>
  const installedVariants = new Map<string, boolean>()
  const runtimeReady = new Map<LocalModelId, boolean>()
  const variantCounts = new Map<string, number>()
  const purposeCounts = { subtitleRecognition: 0, subtitleTranslation: 0, textTranslation: 0 }
  let subtitleLeaseInstaller: ReturnType<typeof createAiRuntimeInstaller> | null = null
  const listeners = new Set<() => void>()
  const supported = options.runtimeSupported ?? aiSubtitleSupported
  const installer = (selection = selected, model = translationModel) => (options.installer ?? createAiRuntimeInstaller)(directory, undefined, localModelAssets(selection, model, undefined, downloadSource), { bundleRoot: options.bundleRoot })
  const referenceLabels = (variant: string): string[] => [
    ...(usage.subtitleRecognition.variant === variant ? ['AI 字幕 · 语音识别'] : []),
    ...(usage.subtitleTranslation.variant === variant ? ['AI 字幕 · 文本翻译'] : []),
    ...(usage.textTranslation.mode === 'local' && usage.textTranslation.variant === variant ? ['文本翻译'] : [])
  ]
  const variantReadiness = (model: LocalModelId, variant: string): LocalModelReadiness => !supported() ? 'unsupported'
    : !installedVariants.get(variant) ? 'missing-model' : !runtimeReady.get(model) ? 'missing-runtime' : 'ready'
  const subtitleSelection = (): typeof selected => ({ ...selected, kotoba: usage.subtitleRecognition.variant,
    [usage.subtitleTranslation.model]: usage.subtitleTranslation.variant })
  const subtitleInstaller = (): ReturnType<typeof createAiRuntimeInstaller> => subtitleLeaseInstaller ?? installer(subtitleSelection(), usage.subtitleTranslation.model)
  const snapshotValue = (): LocalModelSnapshot => ({ revision, usage: structuredClone(usage), supported: supported(), directory, defaultDirectory, downloadSource,
    translation, translationModel, operation, activeModel, activeVariant, downloadBytes, downloadTotal, downloadLabel, error,
    configurationError: configInvalid ? '本地模型用途配置无法读取，请重新保存用途设置后重试' : null,
    models: LOCAL_MODEL_IDS.map(id => ({ id,
      name: LOCAL_MODEL_DEFINITIONS[id].name,
      version: LOCAL_MODEL_DEFINITIONS[id].version,
      purpose: LOCAL_MODEL_DEFINITIONS[id].purpose,
      bytes: localModelVariant(id, selected[id]).asset.bytes,
      selectedVariant: selected[id],
      installed: installed[id], inUse: counts[id] > 0,
      variants: LOCAL_MODEL_VARIANTS.filter(variant => variant.model === id).map(variant => ({
        id: variant.id, precision: variant.precision, format: variant.format, bytes: variant.asset.bytes,
        recommended: variant.recommended, source: variant.asset.url.split('/resolve/')[0], publisher: variant.publisher,
        installed: installedVariants.get(variant.id) === true, inUse: (variantCounts.get(variant.id) ?? 0) > 0,
        references: referenceLabels(variant.id), readiness: variantReadiness(id, variant.id), ready: variantReadiness(id, variant.id) === 'ready'
      })) })) })
  const publish = (): void => { for (const listener of listeners) listener() }
  async function refresh(): Promise<void> {
    for (const variant of LOCAL_MODEL_VARIANTS) {
      installedVariants.set(variant.id, await installer({ ...selected, [variant.model]: variant.id },
        variant.model === 'kotoba' ? translationModel : variant.model).assetsInstalled([LOCAL_MODEL_DEFINITIONS[variant.model].assetId]))
    }
    for (const id of LOCAL_MODEL_IDS) installed[id] = installedVariants.get(selected[id]) === true
    for (const id of LOCAL_MODEL_IDS) runtimeReady.set(id, supported() && await installer(selected, id === 'kotoba' ? translationModel : id)
      .assetsInstalled(LOCAL_MODEL_DEFINITIONS[id].runtimeAssets.filter(asset => asset !== LOCAL_MODEL_DEFINITIONS[id].assetId)))
    publish()
  }
  const ready = (async () => {
    try {
      const config = configSchema.parse(JSON.parse(await fs.readFile(configFile, 'utf8')))
      if (!path.isAbsolute(config.directory)) throw new Error('invalid directory')
      // Storage metadata is independent of purpose bindings. Keep the known location
      // when a purpose reference is damaged so explicit recovery cannot orphan files.
      directory = path.normalize(config.directory)
      downloadSource = config.version >= 4 && 'downloadSource' in config ? config.downloadSource : 'official'
      if (config.version === 5) revision = config.revision
      const next = config.version === 1 ? { ...DEFAULT_LOCAL_MODEL_VARIANTS } : { ...DEFAULT_LOCAL_MODEL_VARIANTS, ...config.selected }
      for (const id of LOCAL_MODEL_IDS) localModelVariant(id, next[id])
      const nextModel = 'translationModel' in config ? config.translationModel : 'qwen3'
      const migratedUsage: LocalModelUsage = {
        subtitleRecognition: { model: 'kotoba', variant: next.kotoba },
        subtitleTranslation: { model: nextModel, variant: next[nextModel] },
        textTranslation: { mode: config.translation, model: nextModel, variant: next[nextModel] }
      }
      selected = next; usage = migratedUsage; translation = config.translation; translationModel = nextModel
      const nextUsage = config.version === 5 ? config.usage : migratedUsage
      for (const ref of Object.values(nextUsage)) localModelVariant(ref.model, ref.variant)
      usage = nextUsage
      translation = usage.textTranslation.mode; translationModel = usage.subtitleTranslation.model
      if (config.version !== 5) await save()
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        configInvalid = true; error = '本地模型用途配置无法读取，请重新保存用途设置后重试'
      }
    }
    await refresh()
  })()
  async function save(nextDirectory = directory, nextTranslation = translation, nextSelected = selected, nextModel = translationModel, nextSource = downloadSource, nextUsage = usage): Promise<void> {
    const nextRevision = randomUUID()
    await atomicWrite(configFile, JSON.stringify({ version: 5, revision: nextRevision, usage: nextUsage, downloadSource: nextSource, directory: nextDirectory, translation: nextTranslation, selected: nextSelected, translationModel: nextModel }))
    revision = nextRevision
  }
  function available(models: LocalModelId[] = []): void {
    if (closed) throw new Error('本地模型管理已关闭')
    if (operation) throw new Error('请等待当前本地模型操作完成')
    if (models.some(id => counts[id] > 0)) throw new Error('模型正在使用，请先停止 AI 字幕或等待翻译完成')
  }
  async function shutdownEngine(): Promise<void> {
    if (idle) clearTimeout(idle); idle = null
    const previous = engine; engine = null
    engineVariant = null
    await previous?.close()
  }
  async function acquire(models: LocalModelId[]): Promise<() => void> {
    await ready
    return acquireReady(models.map(model => ({ model, variant: selected[model] })))
  }
  // Call only after ready. Counts are claimed synchronously before filesystem checks,
  // so choosing a family cannot race the frozen paths of a new translation/subtitle run.
  async function acquireReady(requestedRefs: LocalModelRef[], purposes: Array<keyof LocalModelUsage> = []): Promise<() => void> {
    const refs = [...new Map(requestedRefs.map(ref => [ref.variant, { ...ref }])).values()]
    const models = refs.map(ref => ref.model)
    if (models.filter(id => id !== 'kotoba').length > 1) throw new Error('一次运行只能使用一个本地翻译模型')
    available()
    if (configInvalid) throw new Error('本地模型设置损坏，请重新选择模型设置')
    if (!supported()) throw new Error(AI_RUNTIME_PLATFORM_MESSAGE)
    for (const ref of refs) if (!installedVariants.get(ref.variant)) throw new Error('本地模型未安装，请到设置 → AI 模型 → 本地模型下载')
    for (const ref of refs) { counts[ref.model]++; variantCounts.set(ref.variant, (variantCounts.get(ref.variant) ?? 0) + 1) }
    for (const purpose of purposes) purposeCounts[purpose]++
    publish()
    let released = false
    const release = (): void => {
      if (released) return; released = true
      for (const ref of refs) { counts[ref.model]--; variantCounts.set(ref.variant, (variantCounts.get(ref.variant) ?? 1) - 1) }
      for (const purpose of purposes) purposeCounts[purpose]--
      if (!purposeCounts.subtitleRecognition && !purposeCounts.subtitleTranslation) subtitleLeaseInstaller = null
      publish()
    }
    try {
      const model = models.find((id): id is LocalTranslationModelId => id !== 'kotoba') ?? translationModel
      const selection = { ...selected, ...Object.fromEntries(refs.map(ref => [ref.model, ref.variant])) }
      if (!await installer(selection, model).assetsInstalled([...new Set(models.flatMap(id => LOCAL_MODEL_DEFINITIONS[id].runtimeAssets))])) {
        throw new Error('本地模型运行库不完整，请到模型商店校验与修复当前精度')
      }
      if (closed) throw new Error('本地模型管理已关闭')
      return release
    } catch (cause) { release(); throw cause }
  }
  async function installModels(models: LocalModelId[], signal?: AbortSignal, progress?: (bytes: number, label: string) => void, selection = selected): Promise<void> {
    const includesTranslation = models.some(id => id !== 'kotoba')
    // Translation families share executable/DLL files; repairs must exclude all active translators.
    available(includesTranslation ? [...models, ...LOCAL_TRANSLATION_MODEL_IDS] : models)
    operation = 'download'; activeModel = models.length === 1 ? models[0] : null; error = null
    activeVariant = activeModel ? selection[activeModel] : null
    const abort = new AbortController(); controller = abort
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    const model = models.find((id): id is LocalTranslationModelId => id !== 'kotoba') ?? translationModel
    const ids = [...new Set(models.flatMap(id => supported() ? LOCAL_MODEL_DEFINITIONS[id].runtimeAssets : [LOCAL_MODEL_DEFINITIONS[id].assetId]))]
    downloadBytes = 0; downloadTotal = localModelAssets(selection, model).filter(asset => ids.includes(asset.id)).reduce((sum, asset) => sum + asset.bytes, 0)
    publish()
    let lastPublished = 0
    try {
      // Windows keeps loaded executables/DLLs locked; retire even an idle translator before repair.
      if (includesTranslation) await shutdownEngine()
      await installer(selection, model).install(combined, (bytes, label) => {
        const labelChanged = label !== downloadLabel
        downloadBytes = bytes; downloadLabel = label; progress?.(bytes, label)
        if (labelChanged || Date.now() - lastPublished > 200) { lastPublished = Date.now(); publish() }
      }, ids)
    } catch (cause) {
      if (!combined.aborted) { error = '模型下载或校验失败，可重试续传'; throw cause }
    } finally {
      try { await refresh() }
      finally { operation = null; activeModel = null; activeVariant = null; controller = null; downloadLabel = null; publish() }
    }
  }
  async function remove(id: LocalModelId, requestedVariant?: string): Promise<void> {
    await ready; available()
    const variant = localModelVariant(id, requestedVariant ?? selected[id]).id
    if ((variantCounts.get(variant) ?? 0) > 0) throw new Error('模型正在使用，请先停止 AI 字幕或等待翻译完成')
    const references = referenceLabels(variant)
    if (references.length) throw new Error(`此精度已被 ${references.join('、')} 引用，请先在用途页更换模型`)
    operation = 'delete'; activeModel = id; activeVariant = variant; error = null; publish()
    try {
      if (variant === engineVariant) await shutdownEngine()
      await installer({ ...selected, [id]: variant }, id === 'kotoba' ? translationModel : id).removeAsset(LOCAL_MODEL_DEFINITIONS[id].assetId)
    } finally {
      try { await refresh() }
      finally { operation = null; activeModel = null; activeVariant = null; publish() }
    }
  }
  async function selectVariant(id: LocalModelId, variant: string): Promise<void> {
    localModelVariant(id, variant)
    await ready; available([id])
    if (configInvalid) throw new Error('本地模型设置损坏，请重新选择翻译方式后重试')
    if (variant === selected[id]) return
    const next = { ...selected, [id]: variant }
    operation = 'configure'; error = null; publish()
    try {
      if (!await installer(next, id === 'kotoba' ? translationModel : id).assetsInstalled([LOCAL_MODEL_DEFINITIONS[id].assetId])) throw new Error('请先下载所选精度的模型')
      const nextUsage = structuredClone(usage)
      for (const ref of Object.values(nextUsage)) if (ref.model === id) ref.variant = variant
      if (nextUsage.textTranslation.variant !== usage.textTranslation.variant) await shutdownEngine()
      await save(directory, translation, next, translationModel, downloadSource, nextUsage); selected = next; usage = nextUsage
      await refresh()
    } finally { operation = null; publish() }
  }
  async function selectTranslationModel(model: LocalTranslationModelId): Promise<void> {
    if (!LOCAL_TRANSLATION_MODEL_IDS.includes(model)) throw new Error('未知的本地翻译模型')
    await ready; available([...LOCAL_TRANSLATION_MODEL_IDS])
    if (configInvalid) throw new Error('本地模型设置损坏，请重新选择翻译方式后重试')
    if (model === translationModel) return
    operation = 'configure'; error = null; publish()
    try {
      if (!await installer(selected, model).assetsInstalled(['translation-model'])) throw new Error('请先下载所选本地翻译模型的当前精度')
      await shutdownEngine()
      const nextUsage = { ...usage, subtitleTranslation: { model, variant: selected[model] },
        textTranslation: { ...usage.textTranslation, model, variant: selected[model] } }
      await save(directory, translation, selected, model, downloadSource, nextUsage); translationModel = model; usage = nextUsage
      await refresh()
    } finally { operation = null; publish() }
  }
  async function setUsage(value: LocalModelUsage, expectedRevision?: string): Promise<void> {
    const nextUsage = usageSchema.parse(value)
    for (const ref of Object.values(nextUsage)) localModelVariant(ref.model, ref.variant)
    await ready; available()
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('模型用途设置已更新，请重新读取后再保存')
    const changed = (Object.keys(purposeCounts) as Array<keyof LocalModelUsage>).filter(purpose =>
      JSON.stringify(nextUsage[purpose]) !== JSON.stringify(usage[purpose]))
    if (changed.some(purpose => purposeCounts[purpose] > 0)) throw new Error('该用途正在使用模型，请先停止 AI 字幕或等待文本翻译完成')
    if (!changed.length && !configInvalid) return
    operation = 'configure'; error = null; publish()
    try {
      if (changed.includes('textTranslation')) await shutdownEngine()
      const nextSelected = { ...selected, kotoba: nextUsage.subtitleRecognition.variant,
        [nextUsage.textTranslation.model]: nextUsage.textTranslation.variant,
        [nextUsage.subtitleTranslation.model]: nextUsage.subtitleTranslation.variant }
      await save(directory, nextUsage.textTranslation.mode, nextSelected, nextUsage.subtitleTranslation.model, downloadSource, nextUsage)
      usage = nextUsage; selected = nextSelected; translation = nextUsage.textTranslation.mode; translationModel = nextUsage.subtitleTranslation.model
      configInvalid = false
      await refresh()
    } finally { operation = null; publish() }
  }
  async function relocate(destination: string): Promise<void> {
    await ready; available([...LOCAL_MODEL_IDS])
    if (configInvalid) throw new Error('本地翻译设置损坏，请在设置中重新选择翻译方式')
    if (!path.isAbsolute(destination)) throw new Error('请选择绝对路径的模型保存目录')
    operation = 'relocate'; error = null; publish()
    let stage: string | null = null, target: string | null = null
    let copied = false, committed = false
    try {
      await fs.mkdir(destination, { recursive: true })
      const next = await fs.realpath(destination)
      const old = await fs.realpath(directory).catch(() => path.resolve(directory))
      const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
      // Preserve the default location's identity even when macOS resolves /var to /private/var.
      const canonicalDefault = await fs.realpath(defaultDirectory).catch(() => path.resolve(defaultDirectory))
      const nextDirectory = normalize(next) === normalize(canonicalDefault) ? defaultDirectory : next
      if (normalize(next) === normalize(old)) {
        if (directory !== nextDirectory) { await save(nextDirectory); directory = nextDirectory }
        return
      }
      const contains = (parent: string, child: string): boolean => {
        const relative = path.relative(normalize(parent), normalize(child))
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      }
      const source = path.join(old, AI_SUBTITLE_RUNTIME_VERSION)
      target = path.join(next, AI_SUBTITLE_RUNTIME_VERSION)
      if (contains(source, next) || contains(target, source)) throw new Error('模型新旧目录不能互相包含')
      if (await fs.access(target).then(() => true, () => false)) throw new Error('目标目录已有同版本模型，请选择空目录')
      stage = path.join(next, `.javdex-models-${randomUUID()}`)
      await shutdownEngine()
      const exists = await fs.lstat(source).then(stat => { if (stat.isSymbolicLink()) throw new Error('模型目录不能是符号链接'); return true }, cause => {
        if (cause.code !== 'ENOENT') throw cause; return false
      })
      if (exists) {
        const sourceFiles = await files(source)
        await fs.cp(source, stage, { recursive: true, errorOnExist: true, force: false })
        for (const file of sourceFiles) if (await localModelFileHash(file) !== await localModelFileHash(path.join(stage, path.relative(source, file)))) throw new Error('模型迁移校验失败')
        await fs.rename(stage, target); copied = true
      }
      await save(nextDirectory); directory = nextDirectory; committed = true
      if (exists) await fs.rm(source, { recursive: true, force: true })
    } catch (cause) {
      error = committed ? '新位置已生效，旧模型目录未能清理，可在文件管理器检查' : '模型位置变更失败，原位置仍有效'
      throw cause
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
      if (target && copied && !committed) await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      try { await refresh() }
      finally { operation = null; publish() }
    }
  }
  async function exportModel(id: LocalModelId, destination: string, requestedVariant?: string): Promise<void> {
    await ready; available()
    const entry = localModelVariant(id, requestedVariant ?? selected[id]), variant = entry.id
    if (!installedVariants.get(variant)) throw new Error('请先下载模型')
    operation = 'export'; activeModel = id; activeVariant = variant; error = null; publish()
    let stage: string | null = null
    try {
      await fs.mkdir(path.resolve(destination), { recursive: true })
      const root = await fs.realpath(path.resolve(destination)), current = await fs.realpath(directory)
      const relative = path.relative(current, root)
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('导出目录不能位于模型保存目录内')
      const target = path.join(root, `${LOCAL_MODEL_DEFINITIONS[id].exportName}-${entry.precision}-${entry.publisher}`)
      stage = path.join(root, `.javdex-export-${randomUUID()}`)
      if (await fs.access(target).then(() => true, () => false)) throw new Error('导出目录已有同名模型，请选择其他目录')
      const asset = entry.asset
      const source = path.join(installer().directory, asset.id, asset.filename)
      await fs.mkdir(stage, { recursive: true })
      const filename = path.join(stage, asset.filename)
      await fs.copyFile(source, filename)
      if (await localModelFileHash(filename) !== asset.sha256) throw new Error('模型完整性校验失败，导出已取消')
      await fs.writeFile(path.join(stage, 'LICENSE.txt'), AI_RUNTIME_LICENSES['Apache-2.0.txt'], 'utf8')
      await fs.writeFile(path.join(stage, 'NOTICE.txt'), `${LOCAL_MODEL_DEFINITIONS[id].notice}\nSource: ${asset.url}\n`, 'utf8')
      await fs.writeFile(path.join(stage, 'MODEL.json'), JSON.stringify({ name: id, variant, precision: entry.precision, publisher: entry.publisher, format: entry.format,
        url: asset.url, sha256: asset.sha256, bytes: asset.bytes }, null, 2), 'utf8')
      await fs.rename(stage, target)
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
      operation = null; activeModel = null; activeVariant = null; publish()
    }
  }
  async function translateText(text: string): Promise<string> {
    await ready
    const ref = { ...usage.textTranslation }, model = ref.model
    const release = await acquireReady([ref], ['textTranslation'])
    if (idle) clearTimeout(idle)
    try {
      if (engine && engineVariant !== ref.variant) await shutdownEngine()
      engine ??= (options.inference ?? createOfflineSubtitleInference)(installer({ ...selected, [model]: ref.variant }, model).paths(), path.join(userData, 'local-model-work'))
      engineVariant = ref.variant
      const output: string[] = []
      const characters = Array.from(text)
      if (characters.length > 20000) throw new Error('本地翻译单次最多支持 20000 字，请分段翻译')
      for (let offset = 0; offset < characters.length; offset += 1000) {
        output.push(await engine.translateText(characters.slice(offset, offset + 1000).join(''), new AbortController().signal))
      }
      return output.join('\n')
    } finally {
      release()
      if (!counts[model]) { idle = setTimeout(() => { void shutdownEngine() }, 120000); idle.unref() }
    }
  }
  return {
    async snapshot(): Promise<LocalModelSnapshot> { await ready; return snapshotValue() },
    onChanged(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
    acquire, translateText, relocate, exportModel, remove, selectVariant, selectTranslationModel, setUsage,
    async acquireSubtitleRuntime(): Promise<() => void> {
      await ready
      const runtime = installer(subtitleSelection(), usage.subtitleTranslation.model)
      const lease = acquireReady([usage.subtitleRecognition, usage.subtitleTranslation], ['subtitleRecognition', 'subtitleTranslation'])
      subtitleLeaseInstaller = runtime
      try { return await lease } catch (cause) { if (!purposeCounts.subtitleRecognition) subtitleLeaseInstaller = null; throw cause }
    },
    async mode(): Promise<LocalTranslationMode> {
      await ready
      if (configInvalid) throw new Error('本地翻译设置损坏，请在设置中重新选择翻译方式')
      return usage.textTranslation.mode
    },
    async downloadUrl(id: LocalModelId, requestedVariant?: string): Promise<string> {
      await ready
      const entry = localModelVariant(id, requestedVariant ?? selected[id])
      return localModelAssets({ ...selected, [id]: entry.id }, id === 'kotoba' ? translationModel : id, undefined, downloadSource)
        .find(asset => asset.id === LOCAL_MODEL_DEFINITIONS[id].assetId)!.url
    },
    async importModel(id: LocalModelId, source: string, requestedVariant?: string): Promise<void> {
      await ready; available()
      const entry = localModelVariant(id, requestedVariant ?? selected[id])
      if ((variantCounts.get(entry.id) ?? 0) > 0) throw new Error('模型正在使用，请先停止 AI 字幕或等待翻译完成')
      operation = 'import'; activeModel = id; activeVariant = entry.id; error = null; publish()
      try {
        if (entry.id === engineVariant) await shutdownEngine()
        await importModelFile(source, path.join(installer().directory, entry.asset.id, entry.asset.filename), entry.asset)
      } finally {
        try { await refresh() }
        finally { operation = null; activeModel = null; activeVariant = null; publish() }
      }
    },
    async setDownloadSource(value: LocalModelDownloadSource): Promise<void> {
      if (!LOCAL_MODEL_DOWNLOAD_SOURCES.includes(value)) throw new Error('未知的模型下载来源')
      await ready; available()
      if (configInvalid) throw new Error('本地模型设置损坏，请重新选择翻译方式后重试')
      operation = 'configure'; publish()
      try { await save(directory, translation, selected, translationModel, value); downloadSource = value; error = null }
      finally { operation = null; publish() }
    },
    async setTranslation(value: LocalTranslationMode): Promise<void> {
      await ready; available()
      if (value === 'local' && !supported()) throw new Error(AI_RUNTIME_PLATFORM_MESSAGE)
      if (value === 'local' && !installedVariants.get(usage.textTranslation.variant)) throw new Error(`请先下载 ${LOCAL_MODEL_DEFINITIONS[usage.textTranslation.model].name} 本地翻译模型`)
      if (purposeCounts.textTranslation > 0 && value !== usage.textTranslation.mode) throw new Error('模型正在使用，请等待文本翻译完成')
      operation = 'configure'; publish()
      const nextUsage = { ...usage, textTranslation: { ...usage.textTranslation, mode: value } }
      try { await save(directory, value, selected, translationModel, downloadSource, nextUsage); translation = value; usage = nextUsage; configInvalid = false; error = null }
      finally { operation = null; publish() }
    },
    async download(id: LocalModelId, variant?: string): Promise<void> {
      await ready; available(id === 'kotoba' ? [id] : [...LOCAL_TRANSLATION_MODEL_IDS])
      const entry = localModelVariant(id, variant ?? selected[id])
      const task = installModels([id], undefined, undefined, { ...selected, [id]: entry.id }).catch(() => {}).finally(() => {
        if (pending === task) pending = null
      })
      pending = task
      // Wait for the operation flag so immediately repeated commands cannot start a second task.
      await new Promise<void>(resolve => setImmediate(resolve))
    },
    cancel(): void { controller?.abort() },
    subtitleRuntime(): ReturnType<typeof createAiRuntimeInstaller> {
      return { get directory() { return subtitleInstaller().directory }, paths: () => subtitleInstaller().paths(),
        installed: async () => { await ready; return subtitleInstaller().installed() },
        assetsInstalled: async ids => { await ready; return subtitleInstaller().assetsInstalled(ids) },
        removeAsset: async id => {
          if (id === 'kotoba') await remove('kotoba', usage.subtitleRecognition.variant)
          else if (id === 'translation-model') await remove(usage.subtitleTranslation.model, usage.subtitleTranslation.variant)
          else { await ready; available([...LOCAL_MODEL_IDS]); await subtitleInstaller().removeAsset(id); await refresh() }
        },
        install: async (signal, progress) => { await ready; return installModels(['kotoba', usage.subtitleTranslation.model], signal, progress, subtitleSelection()) },
        remove: async () => { await remove('kotoba', usage.subtitleRecognition.variant); await remove(usage.subtitleTranslation.model, usage.subtitleTranslation.variant) }
      }
    },
    async close(): Promise<void> { closed = true; controller?.abort(); await pending; await shutdownEngine() }
  }
}
