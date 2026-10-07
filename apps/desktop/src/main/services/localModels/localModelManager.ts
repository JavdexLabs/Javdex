import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type { LocalModelId, LocalModelSnapshot, LocalTranslationMode } from '@shared/desktop/localModels'
import { createAiRuntimeInstaller, aiSubtitleSupported } from '../../player/aiSubtitles/runtimeInstaller'
import { AI_SUBTITLE_ASSETS, AI_SUBTITLE_RUNTIME_VERSION, type AiRuntimeAsset } from '../../player/aiSubtitles/runtimeManifest'
import { AI_RUNTIME_LICENSES } from '../../player/aiSubtitles/runtimeLicenses'
import { atomicWrite } from '../../player/aiSubtitles/subtitleCache'
import { createOfflineSubtitleInference } from '../../player/aiSubtitles/offlineInference'

const MODEL_ASSETS: Record<LocalModelId, AiRuntimeAsset['id'][]> = {
  kotoba: ['kotoba', 'whisper', 'ffmpeg', 'vad'], qwen3: ['translation-model', 'translator']
}
const MODEL_ASSET: Record<LocalModelId, AiRuntimeAsset['id']> = { kotoba: 'kotoba', qwen3: 'translation-model' }
const configSchema = z.object({ version: z.literal(1), directory: z.string().min(1), translation: z.enum(['app-default', 'local']) }).strict()
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
} = {}) {
  const defaultDirectory = path.join(userData, 'ai-subtitles', 'models')
  const configFile = path.join(userData, 'local-models.json')
  let directory = defaultDirectory, translation: LocalTranslationMode = 'app-default'
  let configInvalid = false
  let operation: LocalModelSnapshot['operation'] = null, activeModel: LocalModelId | null = null
  let downloadBytes = 0, downloadTotal = 0, downloadLabel: string | null = null, error: string | null = null
  let controller: AbortController | null = null, pending: Promise<void> | null = null
  let closed = false, idle: ReturnType<typeof setTimeout> | null = null
  let engine: ReturnType<typeof createOfflineSubtitleInference> | null = null
  const counts: Record<LocalModelId, number> = { kotoba: 0, qwen3: 0 }
  const installed: Record<LocalModelId, boolean> = { kotoba: false, qwen3: false }
  const listeners = new Set<() => void>()
  const installer = () => (options.installer ?? createAiRuntimeInstaller)(directory)
  const snapshotValue = (): LocalModelSnapshot => ({ supported: aiSubtitleSupported(), directory, defaultDirectory,
    translation, operation, activeModel, downloadBytes, downloadTotal, downloadLabel, error,
    models: (['qwen3', 'kotoba'] as LocalModelId[]).map(id => ({ id,
      name: id === 'qwen3' ? 'Qwen3 1.7B · Q4' : 'Kotoba Whisper v2 · Q5',
      purpose: id === 'qwen3' ? 'AI 文本翻译与字幕中文翻译' : 'AI 字幕日语识别',
      bytes: AI_SUBTITLE_ASSETS.find(asset => asset.id === MODEL_ASSET[id])!.bytes,
      installed: installed[id], inUse: counts[id] > 0 })) })
  const publish = (): void => { for (const listener of listeners) listener() }
  async function refresh(): Promise<void> {
    for (const id of ['kotoba', 'qwen3'] as const) installed[id] = await installer().assetsInstalled(MODEL_ASSETS[id])
    publish()
  }
  const ready = (async () => {
    try {
      const config = configSchema.parse(JSON.parse(await fs.readFile(configFile, 'utf8')))
      if (!path.isAbsolute(config.directory)) throw new Error('invalid directory')
      directory = path.normalize(config.directory); translation = config.translation
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        configInvalid = true; error = '本地模型设置无法读取，请重新选择翻译方式后重试'
      }
    }
    await refresh()
  })()
  const save = async (nextDirectory = directory, nextTranslation = translation): Promise<void> => {
    await atomicWrite(configFile, JSON.stringify({ version: 1, directory: nextDirectory, translation: nextTranslation }))
  }
  function available(models: LocalModelId[] = []): void {
    if (closed) throw new Error('本地模型管理已关闭')
    if (operation) throw new Error('请等待当前本地模型操作完成')
    if (models.some(id => counts[id] > 0)) throw new Error('模型正在使用，请先停止 AI 字幕或等待翻译完成')
  }
  async function shutdownEngine(): Promise<void> {
    if (idle) clearTimeout(idle); idle = null
    const previous = engine; engine = null
    await previous?.close()
  }
  async function acquire(models: LocalModelId[]): Promise<() => void> {
    await ready; available()
    for (const id of models) if (!installed[id]) throw new Error('本地模型未安装，请到设置 → AI 模型 → 本地模型下载')
    for (const id of models) counts[id]++
    publish()
    let released = false
    return () => { if (released) return; released = true; for (const id of models) counts[id]--; publish() }
  }
  async function installModels(models: LocalModelId[], signal?: AbortSignal, progress?: (bytes: number, label: string) => void): Promise<void> {
    available(models)
    operation = 'download'; activeModel = models.length === 1 ? models[0] : null; error = null
    const abort = new AbortController(); controller = abort
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    const ids = [...new Set(models.flatMap(id => MODEL_ASSETS[id]))]
    downloadBytes = 0; downloadTotal = AI_SUBTITLE_ASSETS.filter(asset => ids.includes(asset.id)).reduce((sum, asset) => sum + asset.bytes, 0)
    publish()
    let lastPublished = 0
    try {
      await installer().install(combined, (bytes, label) => {
        const labelChanged = label !== downloadLabel
        downloadBytes = bytes; downloadLabel = label; progress?.(bytes, label)
        if (labelChanged || Date.now() - lastPublished > 200) { lastPublished = Date.now(); publish() }
      }, ids)
    } catch (cause) {
      if (!combined.aborted) { error = '模型下载或校验失败，可重试续传'; throw cause }
    } finally {
      try { await refresh() }
      finally { operation = null; activeModel = null; controller = null; downloadLabel = null; publish() }
    }
  }
  async function remove(id: LocalModelId): Promise<void> {
    await ready; available([id]); operation = 'delete'; activeModel = id; error = null; publish()
    try {
      if (id === 'qwen3') await shutdownEngine()
      await installer().removeAsset(MODEL_ASSET[id])
    } finally {
      try { await refresh() }
      finally { operation = null; activeModel = null; publish() }
    }
  }
  async function relocate(destination: string): Promise<void> {
    await ready; available(['kotoba', 'qwen3'])
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
      if (normalize(next) === normalize(old)) return
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
      await save(next); directory = next; committed = true
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
  async function exportModel(id: LocalModelId, destination: string): Promise<void> {
    await ready; available()
    if (!installed[id]) throw new Error('请先下载模型')
    const root = path.resolve(destination)
    const current = path.resolve(directory)
    const relative = path.relative(current, root)
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('导出目录不能位于模型保存目录内')
    const target = path.join(root, id === 'qwen3' ? 'Qwen3-1.7B-Q4' : 'Kotoba-Whisper-v2-Q5')
    operation = 'export'; activeModel = id; error = null; publish()
    const stage = path.join(root, `.javdex-export-${randomUUID()}`)
    try {
      if (await fs.access(target).then(() => true, () => false)) throw new Error('导出目录已有同名模型，请选择其他目录')
      const asset = AI_SUBTITLE_ASSETS.find(asset => asset.id === MODEL_ASSET[id])!
      const source = path.join(installer().directory, asset.id, asset.filename)
      await fs.mkdir(stage, { recursive: true })
      const filename = path.join(stage, asset.filename)
      await fs.copyFile(source, filename)
      if (await localModelFileHash(filename) !== asset.sha256) throw new Error('模型完整性校验失败，导出已取消')
      await fs.writeFile(path.join(stage, 'LICENSE.txt'), AI_RUNTIME_LICENSES['Apache-2.0.txt'], 'utf8')
      await fs.writeFile(path.join(stage, 'MODEL.json'), JSON.stringify({ name: id, url: asset.url, sha256: asset.sha256, bytes: asset.bytes }, null, 2), 'utf8')
      await fs.rename(stage, target)
    } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); operation = null; activeModel = null; publish() }
  }
  async function translateText(text: string): Promise<string> {
    const release = await acquire(['qwen3'])
    if (idle) clearTimeout(idle)
    try {
      engine ??= (options.inference ?? createOfflineSubtitleInference)(installer().paths(), path.join(userData, 'local-model-work'))
      const output: string[] = []
      const characters = Array.from(text)
      if (characters.length > 20000) throw new Error('本地翻译单次最多支持 20000 字，请分段翻译')
      for (let offset = 0; offset < characters.length; offset += 1000) {
        output.push(await engine.translateText(characters.slice(offset, offset + 1000).join(''), new AbortController().signal))
      }
      return output.join('\n')
    } finally {
      release()
      if (!counts.qwen3) { idle = setTimeout(() => { void shutdownEngine() }, 120000); idle.unref() }
    }
  }
  return {
    async snapshot(): Promise<LocalModelSnapshot> { await ready; return snapshotValue() },
    onChanged(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
    acquire, translateText, relocate, exportModel, remove,
    async mode(): Promise<LocalTranslationMode> {
      await ready
      if (configInvalid) throw new Error('本地翻译设置损坏，请在设置中重新选择翻译方式')
      return translation
    },
    async setTranslation(value: LocalTranslationMode): Promise<void> {
      await ready; available()
      if (value === 'local' && !installed.qwen3) throw new Error('请先下载 Qwen3 本地翻译模型')
      operation = 'configure'; publish()
      try { await save(directory, value); translation = value; configInvalid = false; error = null }
      finally { operation = null; publish() }
    },
    async download(id: LocalModelId): Promise<void> {
      await ready; available([id])
      pending = installModels([id]).catch(() => {}).finally(() => { pending = null })
      // Wait for the operation flag so immediately repeated commands cannot start a second task.
      await new Promise<void>(resolve => setImmediate(resolve))
    },
    cancel(): void { controller?.abort() },
    subtitleRuntime(): ReturnType<typeof createAiRuntimeInstaller> {
      return { get directory() { return installer().directory }, paths: () => installer().paths(),
        installed: async () => { await ready; return installed.kotoba && installed.qwen3 },
        assetsInstalled: ids => installer().assetsInstalled(ids), removeAsset: id => installer().removeAsset(id),
        install: async (signal, progress) => { await ready; return installModels(['kotoba', 'qwen3'], signal, progress) },
        remove: async () => { await remove('kotoba'); await remove('qwen3') }
      }
    },
    async close(): Promise<void> { closed = true; controller?.abort(); await pending; await shutdownEngine() }
  }
}
