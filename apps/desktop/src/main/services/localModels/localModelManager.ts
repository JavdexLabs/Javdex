import fs from 'node:fs/promises'
import { importModelFile } from './importModelFile'
import { createReadStream, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { LOCAL_MODEL_DOWNLOAD_SOURCES, type LocalModelDownloadSource, LOCAL_MODEL_IDS, LOCAL_TRANSLATION_MODEL_IDS, type LocalModelId, type LocalModelSnapshot,
  type LocalTranslationMode, type LocalTranslationModelId } from '@shared/desktop/localModels'
import type { LocalModelRef, LocalModelUsage, LocalModelReadiness, LocalAccelerationPolicy, LocalGpuDevice, LocalExecutionStatus } from '@shared/desktop/localModels'
import type { LocalModelGroup, LocalRuntimeComponent, LocalRuntimeEnvironment, LocalPreparationPlan, LocalDependencyCheck } from '@shared/desktop/localModels'
import { createAiRuntimeInstaller, localModelRuntimeSupported } from './runtimeInstaller'
import { AI_RUNTIME_PLATFORM_MESSAGE, currentAiRuntimeTarget, modelAssetFiles, modelAssetBytes } from './runtimeManifest'
import { runtimeSupportsMetal } from './runtimeDistributionAssets'
import { gpuRuntimeAssets } from './gpuManifest'
import { localGpuTargetSupported, detectLocalGpuDevices, type LocalGpuRuntime } from './runtimeAcceleration'
import { AI_RUNTIME_LICENSES } from './runtimeLicenses'
import { atomicWrite } from '../../utils/atomicWrite'
import { MODEL_STORE_ENTRIES, canonicalStoragePath, localAiDirectories, ensureModelStore, ensureStorageDirectory, cleanModelTemporaryFiles, writeModelManifest, runtimeAssetDirectory, modelDownloadFile } from './modelStorage'
import { runtimeComponentDefinitions, preparationPlan, runtimeBackend } from './runtimeComponents'
import { measureLocalStorage } from './storageUsage'
import { createLocalTextInference } from './textInference'
import { createModelValidation } from './modelValidation'
import { validateModelRuntime } from './validateModelRuntime'
import { isSpeechModel, LOCAL_RECOGNITION_MODEL_IDS, LOCAL_MODEL_GROUPS, localModelGroup, localModelGroupLabel, type LocalRecognitionModelId } from '@shared/desktop/localModels'
import { audioCppAsset, qwenAsrSupported } from './qwenAsrManifest'
type TextEngine = Pick<ReturnType<typeof createLocalTextInference>, 'translateText' | 'close'>
import { DEFAULT_LOCAL_MODEL_VARIANTS, LOCAL_MODEL_DEFINITIONS, LOCAL_MODEL_VARIANTS, localModelAssets, localModelVariant } from './modelCatalog'
const selectedSchema = z.object({ kotoba: z.string(), qwen3: z.string(), 'hy-mt2-7b': z.string() }).strict()
const translationRefSchema = z.object({ model: z.enum(LOCAL_TRANSLATION_MODEL_IDS), variant: z.string().min(1) }).strict()
const usageSchema = z.object({
  subtitleRecognition: z.object({ model: z.enum(LOCAL_RECOGNITION_MODEL_IDS), variant: z.string().min(1) }).strict(),
  subtitleTranslation: translationRefSchema,
  textTranslation: translationRefSchema.extend({ mode: z.enum(['app-default', 'local']) }).strict()
}).strict()
// v1 remains readable without rewriting; explicit acceleration saves introduce v2.
const accelerationSchema = z.object({ mode: z.enum(['auto', 'cpu', 'gpu']), device: z.string().min(1).max(256).optional() }).strict()
  .refine(policy => policy.mode !== 'gpu' || !!policy.device, { message: '请选择显卡' })
const configV1 = z.object({ version: z.literal(1), directory: z.string().min(1),
  downloadSource: z.enum(LOCAL_MODEL_DOWNLOAD_SOURCES), selected: selectedSchema,
  usage: usageSchema.extend({ subtitleRecognition: z.object({ model: z.literal('kotoba'), variant: z.string().min(1) }).strict() }), revision: z.string().min(1) }).strict()
const configSchema = z.discriminatedUnion('version', [configV1, configV1.extend({ version: z.literal(2), acceleration: accelerationSchema }),
  configV1.extend({ version: z.literal(3), selected: selectedSchema.extend({ 'qwen3-asr': z.string().min(1) }), usage: usageSchema, acceleration: accelerationSchema,
    qwenForcedAligner: z.boolean().optional() })])
function defaultUsage(selected = DEFAULT_LOCAL_MODEL_VARIANTS): LocalModelUsage {
  return {
    subtitleRecognition: { model: 'kotoba', variant: selected.kotoba },
    subtitleTranslation: { model: 'hy-mt2-7b', variant: selected['hy-mt2-7b'] },
    textTranslation: { mode: 'local', model: 'hy-mt2-7b', variant: selected['hy-mt2-7b'] }
  }
}
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
  /** Startup choice captured before another service creates fresh cloud settings; saved local usage still wins. */
  initialTextTranslationMode?: LocalTranslationMode
  installer?: typeof createAiRuntimeInstaller
  inference?: (paths: Parameters<typeof createLocalTextInference>[0]) => TextEngine
  runtimeSupported?: typeof localModelRuntimeSupported
  detectDevices?: typeof detectLocalGpuDevices
  validate?: typeof validateModelRuntime
} = {}) {
  const locations = localAiDirectories(userData)
  const defaultDirectory = locations.store
  const configFile = path.join(userData, 'local-models.json')
  let directory = defaultDirectory
  let downloadSource: LocalModelDownloadSource = 'official'
  let selected = { ...DEFAULT_LOCAL_MODEL_VARIANTS }
  let usage = defaultUsage(selected)
  // 0.8.0's translation used the application model and had no local-model file.
  // Desktop captures this before cloud bootstrap; direct compositions use their existing profile.
  usage.textTranslation.mode = options.initialTextTranslationMode
    ?? (existsSync(path.join(userData, 'ai-configuration.json')) ? 'app-default' : 'local')
  let translation: LocalTranslationMode = usage.textTranslation.mode
  let translationModel: LocalTranslationModelId = usage.subtitleTranslation.model
  let revision: string = randomUUID()
  let configInvalid = false
  let configVersion = 1
  let qwenForcedAligner = true
  let accelerationPolicy: LocalAccelerationPolicy = { mode: 'auto' }
  let devices: LocalGpuDevice[] = [], accelerationError: string | null = null
  const executionStatus: Record<'recognition' | 'translation', LocalExecutionStatus> = { recognition: { backend: 'idle' }, translation: { backend: 'idle' } }
  let gpuRuntimes: Partial<Record<'cuda' | 'vulkan', LocalGpuRuntime>> = {}
  const variantExecution = new Map<string, LocalExecutionStatus>()
  const executionGeneration = new Map<string, number>()
  let started = false
  let downloadKind: 'model' | 'acceleration' = 'model'
  let operation: LocalModelSnapshot['operation'] = null, activeModel: LocalModelId | null = null
  let activeVariant: string | null = null
  let downloadBytes = 0, downloadTotal = 0, downloadLabel: string | null = null, error: string | null = null
  const componentDefinitions = runtimeComponentDefinitions(currentAiRuntimeTarget())
  let components: LocalRuntimeComponent[] = []
  const enabledComponents = () => components.filter(item => qwenForcedAligner || item.id !== 'qwen-aligner-common')
  let checkingDependencies = false
  const resumed = new Map<string, number>()
  let preparation: LocalModelSnapshot['preparation']
  let operationError: LocalModelSnapshot['operationError']
  let storage: LocalModelSnapshot['storage']
  const refreshStorage = async (): Promise<void> => {
    storage = await measureLocalStorage(directory, locations, [...new Set(componentDefinitions.flatMap(item => item.asset?.model ? [item.asset.model.family] : []))])
  }
  let controller: AbortController | null = null, pending: Promise<void> | null = null
  let closed = false, idle: ReturnType<typeof setTimeout> | null = null
  let engine: TextEngine | null = null
  let engineVariant: string | null = null
  const counts = Object.fromEntries(LOCAL_MODEL_IDS.map(id => [id, 0])) as Record<LocalModelId, number>
  const installed = Object.fromEntries(LOCAL_MODEL_IDS.map(id => [id, false])) as Record<LocalModelId, boolean>
  const installedVariants = new Map<string, boolean>()
  const variantFiles = new Map<string, boolean>()
  const runtimeReady = (model: LocalModelId): boolean => {
    if (model === 'qwen3-asr' && !qwenAsrSupported(currentAiRuntimeTarget())) return false
    const shared = enabledComponents().filter(item => item.group === localModelGroup(model) && (item.backend === 'cpu' || item.backend === 'common'))
    return supported() && shared.length > 0 && shared.every(item => item.installed)
  }
  const variantCounts = new Map<string, number>()
  const purposeCounts = { subtitleRecognition: 0, subtitleTranslation: 0, textTranslation: 0 }
  let subtitleLeaseInstaller: ReturnType<typeof createAiRuntimeInstaller> | null = null
  const listeners = new Set<() => void>()
  const supported = options.runtimeSupported ?? localModelRuntimeSupported
  const installer = (selection = selected, model = translationModel, recognitionModel: LocalRecognitionModelId = usage.subtitleRecognition.model) => (options.installer ?? createAiRuntimeInstaller)(directory, undefined, localModelAssets(selection, model, undefined, downloadSource), { recognitionModel, qwenForcedAligner })
  const gpuInstaller = (backend: 'cuda' | 'vulkan') => (options.installer ?? createAiRuntimeInstaller)(directory, undefined,
    [...gpuRuntimeAssets(currentAiRuntimeTarget(), backend), ...(backend === 'vulkan' ? audioCppAsset(currentAiRuntimeTarget(), true) : []), ...localModelAssets(selected, translationModel).filter(asset => !asset.archive)])
  const runtimePaths = (runtime: ReturnType<typeof createAiRuntimeInstaller>, refs = {
    recognition: usage.subtitleRecognition.variant, translation: usage.subtitleTranslation.variant
  }) => {
    const epochs = { recognition: executionGeneration.get(refs.recognition), translation: executionGeneration.get(refs.translation) }
    return { ...runtime.paths(), acceleration: {
    policy: { ...accelerationPolicy }, devices: structuredClone(devices), runtimes: structuredClone(gpuRuntimes),
    status: (kind: 'recognition' | 'translation', value: LocalExecutionStatus): void => {
      if (!closed && (variantCounts.get(refs[kind]) ?? 0) > 0 && epochs[kind] === executionGeneration.get(refs[kind])) {
        executionStatus[kind] = value; variantExecution.set(refs[kind], value); publish()
      }
    }
    } }
  }
  async function refreshAcceleration(): Promise<void> {
    gpuRuntimes = {}
    for (const backend of ['cuda', 'vulkan'] as const) {
      if (!gpuRuntimeAssets(currentAiRuntimeTarget(), backend).length) continue
      const runtime = gpuInstaller(backend), paths = runtime.paths()
      const value: LocalGpuRuntime = {}
      if (await runtime.assetsInstalled(backend === 'cuda' ? ['translator', 'cuda'] : ['translator'])) {
        value.translator = paths.translator
        if (backend === 'cuda') value.libraryDirectory = runtimeAssetDirectory(directory, 'cuda', currentAiRuntimeTarget(), 'cuda')
      }
      if (await runtime.assetsInstalled(['whisper'])) value.whisper = paths.whisper
      if (backend === 'vulkan' && paths.qwenAsr && await runtime.assetsInstalled(['audiocpp'])) value.audiocpp = paths.qwenAsr.executable
      gpuRuntimes[backend] = value
    }
  }
  const referenceLabels = (variant: string): string[] => [
    ...(usage.subtitleRecognition.variant === variant ? ['AI 字幕 · 语音识别'] : []),
    ...(usage.subtitleTranslation.variant === variant ? ['AI 字幕 · 文本翻译'] : []),
    ...(usage.textTranslation.mode === 'local' && usage.textTranslation.variant === variant ? ['文本翻译'] : [])
  ]
  const variantReadiness = (model: LocalModelId, variant: string): LocalModelReadiness => !supported() || (model === 'qwen3-asr' && !qwenAsrSupported(currentAiRuntimeTarget())) ? 'unsupported'
    : !installedVariants.get(variant) ? 'missing-model' : !runtimeReady(model) ? 'missing-runtime' : 'ready'
  const sourceUrl = (url: string): string => downloadSource === 'hf-mirror' ? url.replace(/^https:\/\/huggingface\.co\//, 'https://hf-mirror.com/') : url
  function plan(groups: LocalModelGroup[], refs: LocalModelRef[] = [], forceGpu = false, cpuOnly = false): LocalPreparationPlan {
    const availableGroups = groups.filter(group => group !== 'qwen-speech' || qwenAsrSupported(currentAiRuntimeTarget()))
    const value = preparationPlan({ groups: availableGroups, refs, components: enabledComponents(), policy: cpuOnly ? { mode: 'cpu' } : accelerationPolicy, devices, forceGpu,
      target: currentAiRuntimeTarget(), supported: supported(), installed: variant => installedVariants.get(variant) === true, resumed: id => resumed.get(id) ?? 0 })
    return { ...value, items: value.items.map(item => ({ ...item, source: sourceUrl(item.source) })) }
  }
  const detectionComplete = (): boolean => (process.platform !== 'linux' && devices.length > 0) || !!gpuRuntimes.vulkan?.translator || !localGpuTargetSupported()
  function environments(): LocalRuntimeEnvironment[] {
    return LOCAL_MODEL_GROUPS.map(group => {
      const backend = runtimeBackend(group, accelerationPolicy, devices, components)
      const shared = enabledComponents().filter(item => item.group === group)
      const groupSupported = supported() && (group !== 'qwen-speech' || qwenAsrSupported(currentAiRuntimeTarget()))
      const gpuItems = shared.filter(item => item.backend === backend)
      return { group, supported: groupSupported, components: components.filter(item => item.group === group).map(item => ({ ...item,
        ...(item.id === 'qwen-aligner-common' ? { enabled: qwenForcedAligner } : {}), source: sourceUrl(item.source) })), cpuReady: groupSupported && shared.length > 0 && shared.filter(item => item.backend === 'cpu' || item.backend === 'common').every(item => item.installed),
        gpu: { backend: group !== 'qwen-speech' && accelerationPolicy.mode === 'auto' && runtimeSupportsMetal(currentAiRuntimeTarget(), group === 'speech' ? 'whisper' : 'translator') ? 'metal' : backend,
          state: accelerationPolicy.mode === 'cpu' ? 'disabled' : !localGpuTargetSupported() || !shared.some(item => item.backend === 'cuda' || item.backend === 'vulkan') ? 'platform' : backend
            ? gpuItems.length > 0 && gpuItems.every(item => item.installed) ? 'ready' : 'missing'
            : detectionComplete() ? 'unavailable' : 'unchecked' },
        preparation: plan([group]), gpuPreparation: plan([group], [], true) }
    })
  }
  function dependencies(value: LocalPreparationPlan, model?: LocalModelId): LocalDependencyCheck {
    const canRun = supported() && (model !== 'qwen3-asr' || qwenAsrSupported(currentAiRuntimeTarget()))
    const baseMissing = value.items.filter(item => item.action !== 'reuse' && components.some(component => component.id === item.id && (component.backend === 'cpu' || component.backend === 'common')))
    const missing = value.items.filter(item => item.action !== 'reuse').map(item => item.name)
    return { state: checkingDependencies ? 'checking' : !canRun ? 'unsupported' : baseMissing.length ? 'missing' : missing.length ? 'cpu-fallback' : 'ready', missing, backend: value.backend,
      message: checkingDependencies ? '正在检查依赖' : !canRun ? '当前平台仅管理文件' : baseMissing.length ? `待补齐：${baseMissing.map(item => item.name).join('、')}`
        : missing.length ? `CPU 可用；待补齐：${missing.join('、')}` : `依赖检查通过 · ${value.backend.toUpperCase()}` }
  }
  const validation = createModelValidation({
    targets: () => LOCAL_MODEL_VARIANTS.filter(ref => referenceLabels(ref.id).length && variantReadiness(ref.model, ref.id) === 'ready')
      .map(ref => ({ model: ref.model, variant: ref.id })),
    available: () => started && !closed && !configInvalid && !operation && !Object.values(counts).some(Boolean),
    validate: async (ref, signal) => {
      await shutdownEngine(); signal.throwIfAborted()
      return (options.validate ?? validateModelRuntime)(runtimePaths(installer({ ...selected, [ref.model]: ref.variant },
        isSpeechModel(ref.model) ? translationModel : ref.model, isSpeechModel(ref.model) ? ref.model : undefined)), ref.model, signal)
    },
    changed: () => publish()
  })
  const subtitleSelection = (): typeof selected => ({ ...selected, [usage.subtitleRecognition.model]: usage.subtitleRecognition.variant,
    [usage.subtitleTranslation.model]: usage.subtitleTranslation.variant })
  const subtitleInstaller = (): ReturnType<typeof createAiRuntimeInstaller> => subtitleLeaseInstaller ?? installer(subtitleSelection(), usage.subtitleTranslation.model)
  const snapshotValue = (): LocalModelSnapshot => ({ revision, usage: structuredClone(usage), qwenForcedAligner, supported: supported(), directory, defaultDirectory, downloadSource,
    acceleration: { supported: localGpuTargetSupported(), policy: { ...accelerationPolicy }, devices: structuredClone(devices), detectionComplete: detectionComplete(), ...structuredClone(executionStatus), error: accelerationError },
    environments: environments(), checkingDependencies, preparation: preparation && structuredClone(preparation),
    storage: storage && structuredClone(storage), operationError: error && operationError?.message === error ? structuredClone(operationError) : undefined,
    translation, translationModel, operation, activeModel, activeVariant, downloadBytes, downloadTotal, downloadLabel, downloadKind, error,
    configurationError: configInvalid ? '本地模型用途配置无法读取，请重新保存用途设置后重试' : null,
    models: LOCAL_MODEL_IDS.map(id => ({ id,
      name: LOCAL_MODEL_DEFINITIONS[id].name,
      version: LOCAL_MODEL_DEFINITIONS[id].version,
      purpose: LOCAL_MODEL_DEFINITIONS[id].purpose,
      bytes: modelAssetBytes(localModelVariant(id, selected[id]).asset),
      selectedVariant: selected[id],
      installed: installed[id], inUse: counts[id] > 0,
      variants: LOCAL_MODEL_VARIANTS.filter(variant => variant.model === id).map(variant => ({
        id: variant.id, precision: variant.precision, format: variant.format, bytes: modelAssetBytes(variant.asset),
        recommended: variant.recommended, source: variant.asset.url.split('/resolve/')[0], publisher: variant.publisher,
        installed: installedVariants.get(variant.id) === true, hasFiles: variantFiles.get(variant.id) === true, inUse: (variantCounts.get(variant.id) ?? 0) > 0,
        references: referenceLabels(variant.id), readiness: variantReadiness(id, variant.id), ready: variantReadiness(id, variant.id) === 'ready',
        runtimeReady: runtimeReady(id),
        preparation: plan([], [{ model: id, variant: variant.id }]),
        dependencies: dependencies(plan([localModelGroup(id)]), id),
        validation: !checkingDependencies && variantReadiness(id, variant.id) === 'ready' && referenceLabels(variant.id).length
          ? structuredClone(validation.get(variant.id) ?? { state: 'waiting',
            message: Object.values(counts).some(Boolean) ? '等待当前任务完成后验证' : '等待自动验证' }) : undefined,
        execution: variantExecution.get(variant.id) && { ...variantExecution.get(variant.id)! }
      })) })) })
  const publish = (): void => { for (const listener of listeners) listener() }
  async function refresh(): Promise<void> {
    checkingDependencies = true; validation.invalidate(); publish()
    try {
      for (const variant of LOCAL_MODEL_VARIANTS) {
        const runtime = installer({ ...selected, [variant.model]: variant.id }, isSpeechModel(variant.model) ? translationModel : variant.model, isSpeechModel(variant.model) ? variant.model : undefined)
        const assetId = LOCAL_MODEL_DEFINITIONS[variant.model].assetId
        const present = await runtime.assetsInstalled([assetId])
        installedVariants.set(variant.id, present)
        variantFiles.set(variant.id, present || await runtime.assetPresent(assetId))
      }
      for (const id of LOCAL_MODEL_IDS) installed[id] = installedVariants.get(selected[id]) === true
      await refreshAcceleration()
      components = await Promise.all(componentDefinitions.map(async definition => {
        const runtime = definition.component.backend === 'cuda' || definition.component.backend === 'vulkan'
          ? gpuInstaller(definition.component.backend) : installer()
        const installed = supported() && await runtime.assetsInstalled([definition.assetId])
        return { ...definition.component, installed, hasFiles: installed || (supported() && await runtime.assetPresent(definition.assetId)) }
      }))
      resumed.clear()
      const assets = [...componentDefinitions.map(definition => ({ id: definition.component.id, asset: definition.asset })),
        ...LOCAL_MODEL_VARIANTS.map(variant => ({ id: `model:${variant.id}`, asset: variant.asset }))]
      for (const { id, asset } of assets) if (asset) {
        let bytes = 0
        for (const file of modelAssetFiles(asset)) {
          const installed = asset.supportFiles && await fs.lstat(installer().modelFile(file)).catch(() => null)
          if (installed && installed.isFile() && !installed.isSymbolicLink() && installed.size === file.bytes) {
            bytes += file.bytes
          } else {
            const stat = await fs.lstat(modelDownloadFile(directory, file)).catch(() => null)
            if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= file.bytes) bytes += stat.size
          }
        }
        resumed.set(id, bytes)
      }
      // Disk-usage accounting must not turn a usable runtime into an installation failure.
      await refreshStorage().catch(() => { storage = undefined })
    } finally { checkingDependencies = false; publish() }
  }
  const ready = (async () => {
    try {
      const config = configSchema.parse(JSON.parse(await fs.readFile(configFile, 'utf8')))
      if (!path.isAbsolute(config.directory)) throw new Error('invalid directory')
      // Storage metadata is independent of purpose bindings. Keep the known location
      // when a purpose reference is damaged so explicit recovery cannot orphan files.
      directory = path.normalize(config.directory)
      downloadSource = config.downloadSource; revision = config.revision
      configVersion = config.version
      qwenForcedAligner = config.version === 3 ? config.qwenForcedAligner ?? true : true
      accelerationPolicy = config.version !== 1 ? config.acceleration : { mode: 'auto' }
      const restored = { ...DEFAULT_LOCAL_MODEL_VARIANTS, ...config.selected }
      for (const id of LOCAL_MODEL_IDS) localModelVariant(id, restored[id])
      selected = restored; usage = defaultUsage(selected)
      for (const ref of Object.values(config.usage)) localModelVariant(ref.model, ref.variant)
      usage = config.usage
      translation = usage.textTranslation.mode; translationModel = usage.subtitleTranslation.model
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        // Persist the initial choice once: a fresh profile must not change its
        // default on the next launch just because cloud settings now exist.
        await save()
      } else {
        configInvalid = true; error = '本地模型用途配置无法读取，请重新保存用途设置后重试'
      }
    }
    await cleanModelTemporaryFiles(directory)
    await refresh()
    devices = await (options.detectDevices ?? detectLocalGpuDevices)(gpuRuntimes.vulkan)
    started = true; validation.invalidate()
  })()
  async function save(nextDirectory = directory, nextSelected = selected, nextSource = downloadSource, nextUsage = usage, nextPolicy = accelerationPolicy, nextVersion = configVersion, nextQwenForcedAligner = qwenForcedAligner): Promise<void> {
    nextVersion = Math.max(configVersion, nextVersion, nextUsage.subtitleRecognition.model === 'qwen3-asr' ? 3 : 1)
    const { 'qwen3-asr': qwenSelection, ...legacySelected } = nextSelected
    const nextRevision = randomUUID()
    await atomicWrite(configFile, JSON.stringify({ version: nextVersion, revision: nextRevision, usage: nextUsage, downloadSource: nextSource, directory: nextDirectory,
      selected: nextVersion === 3 ? { ...legacySelected, 'qwen3-asr': qwenSelection } : legacySelected,
      ...(nextVersion === 3 ? { qwenForcedAligner: nextQwenForcedAligner } : {}),
      ...(nextVersion >= 2 ? { acceleration: nextPolicy } : {}) }))
    revision = nextRevision
    configVersion = nextVersion
  }
  function available(models: LocalModelId[] = []): void {
    if (closed) throw new Error('本地模型管理已关闭')
    if (operation) throw new Error('请等待当前本地模型操作完成')
    if (models.some(id => counts[id] > 0)) throw new Error('模型正在使用，请先停止使用此模型的任务')
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
  // Drain validation first, then recheck purpose bindings before synchronously claiming
  // leases. A configuration save during probe teardown must not start stale paths.
  async function acquireReady(requestedRefs: LocalModelRef[], purposes: Array<keyof LocalModelUsage> = []): Promise<() => void> {
    await validation.pause()
    if (purposes.some(purpose => !requestedRefs.some(ref => ref.model === usage[purpose].model && ref.variant === usage[purpose].variant))) {
      throw new Error('模型用途已更新，请重新启动任务')
    }
    const refs = [...new Map(requestedRefs.map(ref => [ref.variant, { ...ref }])).values()]
    const models = refs.map(ref => ref.model)
    if (models.filter(id => !isSpeechModel(id)).length > 1) throw new Error('一次运行只能使用一个本地翻译模型')
    available()
    if (configInvalid) throw new Error('本地模型设置损坏，请重新选择模型设置')
    if (!supported()) throw new Error(AI_RUNTIME_PLATFORM_MESSAGE)
    for (const ref of refs) if (!installedVariants.get(ref.variant)) throw new Error('本地模型未安装，请到设置 → AI 模型 → 本地模型下载')
    for (const ref of refs) {
      if (!variantCounts.get(ref.variant) && !(engine && engineVariant === ref.variant && purposes.includes('textTranslation'))) {
        variantExecution.delete(ref.variant)
        executionGeneration.set(ref.variant, (executionGeneration.get(ref.variant) ?? 0) + 1)
      }
      counts[ref.model]++; variantCounts.set(ref.variant, (variantCounts.get(ref.variant) ?? 0) + 1)
    }
    for (const purpose of purposes) purposeCounts[purpose]++
    publish()
    let released = false
    const release = (): void => {
      if (released) return; released = true
      for (const ref of refs) { counts[ref.model]--; variantCounts.set(ref.variant, (variantCounts.get(ref.variant) ?? 1) - 1) }
      for (const purpose of purposes) purposeCounts[purpose]--
      if (!purposeCounts.subtitleRecognition && !purposeCounts.subtitleTranslation) subtitleLeaseInstaller = null
      validation.schedule()
      publish()
    }
    try {
      const model = models.find((id): id is LocalTranslationModelId => !isSpeechModel(id)) ?? translationModel
      const selection = { ...selected, ...Object.fromEntries(refs.map(ref => [ref.model, ref.variant])) }
      if (!await installer(selection, model).assetsInstalled([...new Set(models.flatMap(id => LOCAL_MODEL_DEFINITIONS[id].runtimeAssets))].filter(id => qwenForcedAligner || id !== 'qwen-aligner'))) {
        throw new Error('本地模型运行库不完整，请到模型商店校验与修复当前精度')
      }
      if (closed) throw new Error('本地模型管理已关闭')
      return release
    } catch (cause) { release(); throw cause }
  }
  async function installModels(models: LocalModelId[], signal?: AbortSignal, progress?: (bytes: number, label: string) => void, selection = selected): Promise<void> {
    const refs = models.map(model => ({ model, variant: selection[model] }))
    await runPreparation(() => {
      for (const model of models) requireBaseEnvironment(model)
      return plan([], refs)
    }, refs, signal, progress)
  }
  function requireBaseEnvironment(model: LocalModelId): void {
    if (model === 'qwen3-asr' && !qwenAsrSupported(currentAiRuntimeTarget())) return
    const group = localModelGroup(model)
    if (supported() && !runtimeReady(model)) throw new Error(`请先安装${localModelGroupLabel(group)}${group === 'text' ? '模型' : ''}的基础运行环境；GPU 加速支持可选`)
  }
  async function runPreparation(createPlan: () => LocalPreparationPlan, refs: LocalModelRef[] = [], signal?: AbortSignal,
    progress?: (bytes: number, label: string) => void, kind: 'model' | 'acceleration' = 'model', retry?: NonNullable<LocalModelSnapshot['operationError']>['command']): Promise<void> {
    await validation.pause()
    const value = createPlan()
    const groups = [...new Set(value.items.map(item => item.group))]
    const includesTranslation = groups.includes('text')
    // Translation families share executable/DLL files; repairs must exclude all active translators.
    available([...(groups.some(group => group !== 'text') ? LOCAL_RECOGNITION_MODEL_IDS : []), ...(includesTranslation ? LOCAL_TRANSLATION_MODEL_IDS : [])])
    operation = 'download'; downloadKind = kind; activeModel = refs.length === 1 ? refs[0].model : null; error = null; operationError = undefined; accelerationError = null
    activeVariant = refs.length === 1 ? refs[0].variant : null
    const abort = new AbortController(); controller = abort
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    preparation = { plan: structuredClone(value), phase: 'checking', itemId: value.items[0]?.id ?? '', completedItems: 0 }
    const selection = { ...selected, ...Object.fromEntries(refs.map(ref => [ref.model, ref.variant])) }
    downloadBytes = 0; downloadTotal = value.downloadBytes; downloadLabel = null
    publish()
    let lastPublished = 0, completedNetwork = 0
    try {
      // Windows keeps loaded executables/DLLs locked; retire even an idle translator before repair.
      if (includesTranslation) await shutdownEngine()
      await cleanModelTemporaryFiles(directory)
      for (const [index, item] of preparation.plan.items.entries()) {
        combined.throwIfAborted()
        const definition = componentDefinitions.find(entry => entry.component.id === item.id)
        const ref = refs.find(entry => item.id === `model:${entry.variant}`)
        const runtime = definition && (definition.component.backend === 'cuda' || definition.component.backend === 'vulkan')
          ? gpuInstaller(definition.component.backend) : installer(selection, ref && !isSpeechModel(ref.model) ? ref.model : translationModel)
        const assetId = definition?.assetId ?? (ref ? LOCAL_MODEL_DEFINITIONS[ref.model].assetId : undefined)
        if (!assetId) throw new Error('准备清单包含未知组件')
        preparation.itemId = item.id; preparation.phase = 'checking'; downloadLabel = item.name; publish()
        let transferred = 0, hasEvents = false
        await runtime.install(combined, () => {}, [assetId], event => {
          hasEvents = true
          const previous = preparation!.phase
          if (event.phase === 'downloading') { item.downloadBytes = event.networkTotal; item.action = 'download' }
          if (event.phase === 'reused') { item.downloadBytes = 0; item.action = 'reuse' }
          transferred = event.networkBytes
          downloadBytes = completedNetwork + transferred
          downloadTotal = completedNetwork + item.downloadBytes + preparation!.plan.items.slice(index + 1).reduce((sum, remaining) => sum + remaining.downloadBytes, 0)
          preparation!.plan.downloadBytes = downloadTotal
          if (event.phase !== 'reused' && event.phase !== 'complete') preparation!.phase = event.phase
          progress?.(downloadBytes, item.name)
          if (previous !== preparation!.phase || event.phase === 'reused' || Date.now() - lastPublished > 200) { lastPublished = Date.now(); publish() }
        })
        // Custom hosts can provide an installer without detailed network events.
        if (!hasEvents) transferred = 0
        completedNetwork += transferred; preparation.completedItems = index + 1
      }
    } catch (cause) {
      if (!combined.aborted) {
        const detail = cause instanceof Error ? cause.message : '未知错误'
        const item = preparation?.plan.items.find(item => item.id === preparation?.itemId)
        const source = item?.source.startsWith('https://') ? new URL(item.source).hostname : '应用内置组件'
        const phase = preparation?.phase === 'downloading' ? '下载' : preparation?.phase === 'installing' ? '安装' : '校验'
        error = `${downloadLabel ?? '本地运行准备'} · ${phase}（${source}）：${detail}。可重试续传或修复`
        const failedRef = refs.find(ref => item?.id === `model:${ref.variant}`)
        operationError = { message: error, command: retry ?? (failedRef || refs.length === 1 ? { action: 'download', ...(failedRef ?? refs[0]) }
          : item ? { action: 'prepare-runtime', group: item.group, target: value.backend === 'cpu' || value.backend === 'metal' ? 'cpu' : 'gpu' } : { action: 'prepare-acceleration' }) }
        throw cause
      }
    } finally {
      try { await refresh(); devices = await (options.detectDevices ?? detectLocalGpuDevices)(gpuRuntimes.vulkan) }
      finally { operation = null; validation.schedule(); activeModel = null; activeVariant = null; controller = null; downloadLabel = null; preparation = undefined; publish() }
    }
  }
  async function remove(id: LocalModelId, requestedVariant?: string): Promise<void> {
    await ready; await validation.pause(); available()
    const variant = localModelVariant(id, requestedVariant ?? selected[id]).id
    if ((variantCounts.get(variant) ?? 0) > 0) throw new Error('模型正在使用，请先停止使用此模型的任务')
    operation = 'delete'; activeModel = id; activeVariant = variant; error = null; publish()
    try {
      if (variant === engineVariant) await shutdownEngine()
      await installer({ ...selected, [id]: variant }, isSpeechModel(id) ? translationModel : id).removeAsset(LOCAL_MODEL_DEFINITIONS[id].assetId)
    } finally {
      try { await refresh() }
      finally { operation = null; validation.schedule(); activeModel = null; activeVariant = null; publish() }
    }
  }
  async function removeRuntime(group: LocalModelGroup, target: 'cpu' | 'gpu'): Promise<void> {
    await ready; await validation.pause(); available([...LOCAL_MODEL_IDS])
    if (!LOCAL_MODEL_GROUPS.includes(group) || !['cpu', 'gpu'].includes(target)) throw new Error('未知运行环境')
    const definitions = componentDefinitions.filter(({ component }) => component.group === group
      && (target === 'cpu' ? component.backend === 'cpu' || component.backend === 'common' : component.backend === 'cuda' || component.backend === 'vulkan'))
    if (!definitions.length) throw new Error('没有可删除的运行环境')
    // Claim the operation before any filesystem await, so a task or import cannot race this check.
    operation = 'delete'; error = null; publish()
    try {
      if (target === 'cpu') {
        let hasModels = false
        const variants = LOCAL_MODEL_VARIANTS.filter(variant => localModelGroup(variant.model) === group)
        for (const variant of variants) {
          const runtime = installer({ ...selected, [variant.model]: variant.id }, isSpeechModel(variant.model) ? translationModel : variant.model)
          const id = LOCAL_MODEL_DEFINITIONS[variant.model].assetId
          if (await runtime.assetsInstalled([id]) || await runtime.assetPresent(id)) { hasModels = true; break }
        }
        // Protect older revisions within the same model families without inspecting the other modality or VAD.
        for (const family of new Set(variants.map(variant => variant.asset.model!.family))) {
          if (hasModels) break
          const remaining = await files(path.join(directory, 'models', family)).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return [] })
          hasModels = remaining.length > 0
        }
        const groupName = localModelGroupLabel(group)
        if (hasModels) throw new Error(`请先删除所有${groupName}${group === 'text' ? '模型' : ''}文件（包括未完成的模型下载），再删除${groupName}基础运行环境`)
      }
      await shutdownEngine()
      for (const definition of definitions) {
        // Both speech modules reference the same physical audio tools. Retain
        // those tools while the other module still has model files.
        if (definition.assetId === 'ffmpeg' && LOCAL_MODEL_VARIANTS.some(variant => isSpeechModel(variant.model)
          && localModelGroup(variant.model) !== group && (installedVariants.get(variant.id) || variantFiles.get(variant.id)))) continue
        const backend = definition.component.backend
        await (backend === 'cuda' || backend === 'vulkan' ? gpuInstaller(backend) : installer()).removeAsset(definition.assetId)
      }
    } finally {
      try { await refresh(); devices = await (options.detectDevices ?? detectLocalGpuDevices)(gpuRuntimes.vulkan) }
      finally { operation = null; validation.schedule(); publish() }
    }
  }
  async function selectVariant(id: LocalModelId, variant: string): Promise<void> {
    localModelVariant(id, variant)
    await ready; await validation.pause(); available([id])
    if (configInvalid) throw new Error('本地模型设置损坏，请重新选择翻译方式后重试')
    if (variant === selected[id]) return
    const next = { ...selected, [id]: variant }
    operation = 'configure'; error = null; publish()
    try {
      if (!await installer(next, isSpeechModel(id) ? translationModel : id).assetsInstalled([LOCAL_MODEL_DEFINITIONS[id].assetId])) throw new Error('请先下载所选精度的模型')
      const nextUsage = structuredClone(usage)
      for (const ref of Object.values(nextUsage)) if (ref.model === id) ref.variant = variant
      if (nextUsage.textTranslation.variant !== usage.textTranslation.variant) await shutdownEngine()
      await save(directory, next, downloadSource, nextUsage); selected = next; usage = nextUsage
      await refresh()
    } finally { operation = null; validation.schedule(); publish() }
  }
  async function selectTranslationModel(model: LocalTranslationModelId): Promise<void> {
    if (!LOCAL_TRANSLATION_MODEL_IDS.includes(model)) throw new Error('未知的本地翻译模型')
    await ready; await validation.pause(); available([...LOCAL_TRANSLATION_MODEL_IDS])
    if (configInvalid) throw new Error('本地模型设置损坏，请重新选择翻译方式后重试')
    if (model === translationModel) return
    operation = 'configure'; error = null; publish()
    try {
      if (!await installer(selected, model).assetsInstalled(['translation-model'])) throw new Error('请先下载所选本地翻译模型的当前精度')
      await shutdownEngine()
      const nextUsage = { ...usage, subtitleTranslation: { model, variant: selected[model] },
        textTranslation: { ...usage.textTranslation, model, variant: selected[model] } }
      await save(directory, selected, downloadSource, nextUsage); translationModel = model; usage = nextUsage
      await refresh()
    } finally { operation = null; validation.schedule(); publish() }
  }
  async function setUsage(value: LocalModelUsage, expectedRevision?: string): Promise<void> {
    const nextUsage = usageSchema.parse(value)
    for (const ref of Object.values(nextUsage)) localModelVariant(ref.model, ref.variant)
    await ready; await validation.pause(); available()
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('模型用途设置已更新，请重新读取后再保存')
    const changed = (Object.keys(purposeCounts) as Array<keyof LocalModelUsage>).filter(purpose =>
      JSON.stringify(nextUsage[purpose]) !== JSON.stringify(usage[purpose]))
    if (changed.some(purpose => purposeCounts[purpose] > 0)) throw new Error('该用途正在使用模型，请先停止 AI 字幕或等待文本翻译完成')
    if (!changed.length && !configInvalid) return
    operation = 'configure'; error = null; publish()
    try {
      if (changed.includes('textTranslation')) await shutdownEngine()
      const nextSelected = { ...selected, [nextUsage.subtitleRecognition.model]: nextUsage.subtitleRecognition.variant,
        [nextUsage.textTranslation.model]: nextUsage.textTranslation.variant,
        [nextUsage.subtitleTranslation.model]: nextUsage.subtitleTranslation.variant }
      await save(directory, nextSelected, downloadSource, nextUsage)
      usage = nextUsage; selected = nextSelected; translation = nextUsage.textTranslation.mode; translationModel = nextUsage.subtitleTranslation.model
      configInvalid = false
      await refresh()
    } finally { operation = null; validation.schedule(); publish() }
  }
  async function relocate(destination: string): Promise<void> {
    await ready; await validation.pause(); available([...LOCAL_MODEL_IDS])
    if (configInvalid) throw new Error('本地翻译设置损坏，请在设置中重新选择翻译方式')
    if (!path.isAbsolute(destination)) throw new Error('请选择绝对路径的模型保存目录')
    operation = 'relocate'; error = null; publish()
    let stage: string | null = null
    let committed = false
    try {
      const next = await canonicalStoragePath(path.resolve(destination))
      const old = await fs.realpath(directory).catch(() => path.resolve(directory))
      const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
      // Preserve the default location's identity even when macOS resolves /var to /private/var.
      const canonicalDefault = await canonicalStoragePath(defaultDirectory)
      const nextDirectory = normalize(next) === normalize(canonicalDefault) ? defaultDirectory : next
      if (normalize(next) === normalize(old)) {
        if (directory !== nextDirectory) { await save(nextDirectory); directory = nextDirectory }
        return
      }
      const contains = (parent: string, child: string): boolean => {
        const relative = path.relative(normalize(parent), normalize(child))
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      }
      if (contains(old, next) || contains(next, old)) throw new Error('模型新旧目录不能互相包含')
      await ensureStorageDirectory(next)
      await ensureModelStore(old)
      for (const entry of MODEL_STORE_ENTRIES) {
        if (await fs.access(path.join(next, entry)).then(() => true, () => false)) throw new Error('目标目录已有模型存储内容，请选择空目录')
      }
      stage = path.join(next, `.javdex-models-${randomUUID()}`)
      await fs.mkdir(stage)
      await shutdownEngine()
      const existing: string[] = []
      for (const entry of MODEL_STORE_ENTRIES) {
        const source = path.join(old, entry)
        const stat = await fs.lstat(source).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null })
        if (!stat) continue
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('模型目录包含不支持的链接或文件')
        const sourceFiles = stat.isDirectory() ? await files(source) : [source]
        await fs.cp(source, path.join(stage, entry), { recursive: true, errorOnExist: true, force: false })
        for (const file of sourceFiles) {
          if (await localModelFileHash(file) !== await localModelFileHash(path.join(stage, path.relative(old, file)))) throw new Error('模型迁移校验失败')
        }
        existing.push(entry)
      }
      const promoted: string[] = []
      try {
        for (const entry of existing) { await fs.rename(path.join(stage, entry), path.join(next, entry)); promoted.push(entry) }
        await save(nextDirectory); directory = nextDirectory; committed = true
      } catch (cause) {
        for (const entry of promoted.reverse()) await fs.rename(path.join(next, entry), path.join(stage, entry))
        throw cause
      }
      for (const entry of existing) await fs.rm(path.join(old, entry), { recursive: true, force: true })
      await fs.rmdir(path.join(old, 'staging')).catch(cause => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cause.code)) throw cause })
      // Old roots can contain unrelated files: remove only an empty managed root.
      await fs.rmdir(old).catch(cause => { if (!['ENOTEMPTY', 'EEXIST'].includes(cause.code)) throw cause })
    } catch (cause) {
      error = committed ? '新位置已生效，旧模型目录未能清理，可在文件管理器检查' : '模型位置变更失败，原位置仍有效'
      throw cause
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
      try { await refresh() }
      finally { operation = null; validation.schedule(); publish() }
    }
  }
  async function exportModel(id: LocalModelId, destination: string, requestedVariant?: string): Promise<void> {
    await ready; await validation.pause(); available()
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
      await fs.mkdir(stage, { recursive: true })
      for (const file of modelAssetFiles(asset)) {
        const filename = path.join(stage, file.filename)
        await fs.copyFile(installer().modelFile(file), filename)
        if (await localModelFileHash(filename) !== file.sha256) throw new Error('模型完整性校验失败，导出已取消')
      }
      await fs.writeFile(path.join(stage, 'LICENSE.txt'), asset.modelNotice ?? AI_RUNTIME_LICENSES['Apache-2.0.txt'], 'utf8')
      await fs.writeFile(path.join(stage, 'NOTICE.txt'), `${LOCAL_MODEL_DEFINITIONS[id].notice}\nSource: ${asset.url}\n`, 'utf8')
      await fs.writeFile(path.join(stage, 'MODEL.json'), JSON.stringify({ name: id, variant, precision: entry.precision, publisher: entry.publisher, format: entry.format,
        url: asset.url, sha256: asset.sha256, bytes: asset.bytes, ...(asset.supportFiles ? { supportFiles: asset.supportFiles } : {}) }, null, 2), 'utf8')
      await fs.rename(stage, target)
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
      operation = null; validation.schedule(); activeModel = null; activeVariant = null; publish()
    }
  }
  async function translateText(text: string): Promise<string> {
    await ready
    const ref = { ...usage.textTranslation }, model = ref.model
    const release = await acquireReady([ref], ['textTranslation'])
    if (idle) clearTimeout(idle)
    try {
      if (engine && engineVariant !== ref.variant) await shutdownEngine()
      engine ??= (options.inference ?? createLocalTextInference)(runtimePaths(installer({ ...selected, [model]: ref.variant }, model),
        { recognition: usage.subtitleRecognition.variant, translation: ref.variant }))
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
    async setQwenForcedAligner(enabled: boolean, expectedRevision?: string): Promise<void> {
      z.boolean().parse(enabled)
      await ready; await validation.pause(); available(['qwen3-asr'])
      if (configInvalid) throw new Error('本地模型配置损坏，请先重新保存用途设置')
      if (expectedRevision !== undefined && revision !== expectedRevision) throw new Error('本地模型设置已更新，请重新读取后保存')
      operation = 'configure'; error = null; publish()
      try {
        await save(directory, selected, downloadSource, usage, accelerationPolicy, 3, enabled)
        qwenForcedAligner = enabled
        variantExecution.delete(selected['qwen3-asr'])
        await refresh()
      } finally { operation = null; validation.schedule(); publish() }
    },
    async setAcceleration(value: LocalAccelerationPolicy, expectedRevision?: string): Promise<void> {
      const policy = accelerationSchema.parse(value)
      if (policy.mode === 'gpu' && !policy.device) throw new Error('请选择显卡')
      await ready; await validation.pause(); available([...LOCAL_MODEL_IDS])
      if (configInvalid) throw new Error('本地模型配置损坏，请先重新保存用途设置')
      if (expectedRevision !== undefined && revision !== expectedRevision) throw new Error('本地模型设置已更新，请重新读取后保存')
      operation = 'configure'; publish()
      try {
        await shutdownEngine()
        await save(directory, selected, downloadSource, usage, policy, 2)
        accelerationPolicy = policy; accelerationError = null
        executionStatus.recognition = { backend: 'idle' }; executionStatus.translation = { backend: 'idle' }
        variantExecution.clear(); await refresh()
      } finally { operation = null; validation.schedule(); publish() }
    },
    async detectDevices(): Promise<void> {
      await ready; await validation.pause(); available()
      operation = 'configure'; publish()
      try { await refresh(); devices = await (options.detectDevices ?? detectLocalGpuDevices)(gpuRuntimes.vulkan); accelerationError = null; validation.invalidate() }
      finally { operation = null; validation.schedule(); publish() }
    },
    async prepareAcceleration(model?: LocalModelId, requestedVariant?: string): Promise<void> {
      await ready; await validation.pause(); available([...LOCAL_MODEL_IDS])
      if (!localGpuTargetSupported() || process.arch !== 'x64') throw new Error('当前平台沿用已有 CPU／Metal 运行库')
      if (configInvalid) throw new Error('本地模型配置损坏，请先重新保存用途设置')
      if (model) localModelVariant(model, requestedVariant ?? selected[model])
      const groups: LocalModelGroup[] = model ? [localModelGroup(model)] : [...LOCAL_MODEL_GROUPS]
      const task = runPreparation(() => plan(groups, [], true), [], undefined, undefined, 'acceleration', { action: 'prepare-acceleration', model, variant: requestedVariant }).catch(() => {}).finally(() => { if (pending === task) pending = null })
      pending = task
      await new Promise<void>(resolve => setImmediate(resolve))
    },
    async prepareRuntime(group: LocalModelGroup, target: 'auto' | 'cpu' | 'gpu'): Promise<void> {
      await ready; await validation.pause(); available()
      if (!supported()) throw new Error(AI_RUNTIME_PLATFORM_MESSAGE)
      if (group === 'qwen-speech' && !qwenAsrSupported(currentAiRuntimeTarget())) throw new Error('语音模型-ASR 的 audio.cpp 运行库当前支持 Windows x64')
      if (configInvalid) throw new Error('本地模型配置损坏，请先重新保存用途设置')
      const task = runPreparation(() => plan([group], [], target === 'gpu', target === 'cpu'), [], undefined, undefined, 'acceleration', { action: 'prepare-runtime', group, target })
        .catch(() => {}).finally(() => { if (pending === task) pending = null })
      pending = task
      await new Promise<void>(resolve => setImmediate(resolve))
    },
    async snapshot(): Promise<LocalModelSnapshot> { await ready; return snapshotValue() },
    onChanged(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
    async cleanDownloads(): Promise<void> {
      await ready; await validation.pause(); available([...LOCAL_MODEL_IDS])
      operation = 'cleanup'; error = null; publish()
      try { await cleanModelTemporaryFiles(directory, true) }
      finally { try { await refresh() } finally { operation = null; validation.schedule(); publish() } }
    },
    async clearCache(): Promise<void> {
      await ready; await validation.pause(); available([...LOCAL_MODEL_IDS])
      operation = 'cleanup'; error = null; publish()
      try {
        for (const root of [locations.cache, locations.work]) {
          await ensureStorageDirectory(root)
          await fs.rm(root, { recursive: true, force: true })
        }
      } finally { try { await refreshStorage() } finally { operation = null; validation.schedule(); publish() } }
    },
    async refreshStorage(): Promise<void> { await ready; await refreshStorage(); publish() },
    acquire, translateText, relocate, exportModel, remove, removeRuntime, selectVariant, selectTranslationModel, setUsage,
    async acquireSubtitleRuntime(): Promise<() => void> {
      await ready
      const runtime = installer(subtitleSelection(), usage.subtitleTranslation.model)
      const lease = acquireReady([usage.subtitleRecognition, usage.subtitleTranslation], ['subtitleRecognition', 'subtitleTranslation'])
      subtitleLeaseInstaller = runtime
      try {
        const release = await lease
        if (runtime.paths().recognitionModel === 'qwen3-asr' && runtime.paths().qwenAsr?.forcedAligner !== qwenForcedAligner) {
          release(); throw new Error('对齐设置已更新，请重新启动任务')
        }
        return release
      } catch (cause) { if (!purposeCounts.subtitleRecognition) subtitleLeaseInstaller = null; throw cause }
    },
    async mode(): Promise<LocalTranslationMode> {
      await ready
      if (configInvalid) throw new Error('本地翻译设置损坏，请在设置中重新选择翻译方式')
      return usage.textTranslation.mode
    },
    async downloadUrl(id: LocalModelId, requestedVariant?: string): Promise<string> {
      await ready
      const entry = localModelVariant(id, requestedVariant ?? selected[id])
      return localModelAssets({ ...selected, [id]: entry.id }, isSpeechModel(id) ? translationModel : id, undefined, downloadSource)
        .find(asset => asset.id === LOCAL_MODEL_DEFINITIONS[id].assetId)!.url
    },
    async importModel(id: LocalModelId, source: string, requestedVariant?: string): Promise<void> {
      await ready; await validation.pause(); available()
      const entry = localModelVariant(id, requestedVariant ?? selected[id])
      if ((variantCounts.get(entry.id) ?? 0) > 0) throw new Error('模型正在使用，请先停止使用此模型的任务')
      requireBaseEnvironment(id)
      operation = 'import'; activeModel = id; activeVariant = entry.id; error = null; publish()
      try {
        if (entry.id === engineVariant) await shutdownEngine()
        await ensureModelStore(directory)
        const destination = installer().modelFile(entry.asset)
        await ensureStorageDirectory(directory, path.dirname(destination))
        await ensureStorageDirectory(directory, path.join(directory, 'staging'))
        for (const [index, file] of modelAssetFiles(entry.asset).entries()) {
          const input = index === 0 ? source : path.join(path.dirname(source), file.filename)
          const stat = await fs.stat(input).catch(() => null)
          if (!stat?.isFile() || stat.size !== file.bytes) throw new Error(`文件大小与所选模型精度不匹配，请检查下载是否完整：${file.filename}`)
        }
        for (const [index, file] of modelAssetFiles(entry.asset).entries()) {
          await importModelFile(index === 0 ? source : path.join(path.dirname(source), file.filename),
            installer().modelFile(file), file, path.join(directory, 'staging'))
        }
        await writeModelManifest(directory, entry.asset)
      } finally {
        try { await refresh() }
        finally { operation = null; validation.schedule(); activeModel = null; activeVariant = null; publish() }
      }
    },
    async setDownloadSource(value: LocalModelDownloadSource): Promise<void> {
      if (!LOCAL_MODEL_DOWNLOAD_SOURCES.includes(value)) throw new Error('未知的模型下载来源')
      await ready; await validation.pause(); available()
      if (configInvalid) throw new Error('本地模型设置损坏，请重新选择翻译方式后重试')
      operation = 'configure'; publish()
      try { await save(directory, selected, value); downloadSource = value; error = null }
      finally { operation = null; validation.schedule(); publish() }
    },
    async setTranslation(value: LocalTranslationMode): Promise<void> {
      await ready; await validation.pause(); available()
      if (value === 'local' && !supported()) throw new Error(AI_RUNTIME_PLATFORM_MESSAGE)
      if (value === 'local' && !installedVariants.get(usage.textTranslation.variant)) throw new Error(`请先下载 ${LOCAL_MODEL_DEFINITIONS[usage.textTranslation.model].name} 本地翻译模型`)
      if (purposeCounts.textTranslation > 0 && value !== usage.textTranslation.mode) throw new Error('模型正在使用，请等待文本翻译完成')
      operation = 'configure'; publish()
      const nextUsage = { ...usage, textTranslation: { ...usage.textTranslation, mode: value } }
      try { await save(directory, selected, downloadSource, nextUsage); translation = value; usage = nextUsage; configInvalid = false; error = null; validation.invalidate() }
      finally { operation = null; validation.schedule(); publish() }
    },
    async download(id: LocalModelId, variant?: string): Promise<void> {
      await ready; await validation.pause(); available(isSpeechModel(id) ? [id] : [...LOCAL_TRANSLATION_MODEL_IDS])
      const entry = localModelVariant(id, variant ?? selected[id])
      requireBaseEnvironment(id)
      const task = installModels([id], undefined, undefined, { ...selected, [id]: entry.id }).catch(() => {}).finally(() => {
        if (pending === task) pending = null
      })
      pending = task
      // Wait for the operation flag so immediately repeated commands cannot start a second task.
      await new Promise<void>(resolve => setImmediate(resolve))
    },
    cancel(): void { controller?.abort() },
    subtitleRuntime(): ReturnType<typeof createAiRuntimeInstaller> {
      return { get directory() { return subtitleInstaller().directory }, paths: () => runtimePaths(subtitleInstaller()),
        modelFile: asset => subtitleInstaller().modelFile(asset),
        installed: async () => { await ready; return subtitleInstaller().installed() },
        assetsInstalled: async ids => { await ready; return subtitleInstaller().assetsInstalled(ids) },
        assetPresent: async id => { await ready; return subtitleInstaller().assetPresent(id) },
        removeAsset: async id => {
          if (id === 'kotoba' || id === 'qwen-asr') await remove(usage.subtitleRecognition.model, usage.subtitleRecognition.variant)
          else if (id === 'translation-model') await remove(usage.subtitleTranslation.model, usage.subtitleTranslation.variant)
          else throw new Error('不支持删除单个组件，请在本地模型页删除整组运行环境')
        },
        install: async (signal, progress) => { await ready; return installModels([usage.subtitleRecognition.model, usage.subtitleTranslation.model], signal, progress, subtitleSelection()) },
        remove: async () => { await remove(usage.subtitleRecognition.model, usage.subtitleRecognition.variant); await remove(usage.subtitleTranslation.model, usage.subtitleTranslation.variant) }
      }
    },
    async close(): Promise<void> {
      closed = true; controller?.abort()
      await validation.close()
      // The caller may remove the profile after close. Drain startup filesystem
      // work too; startup failures remain observable through snapshot/mode.
      await ready.catch(() => {})
      await pending; await shutdownEngine()
    }
  }
}
