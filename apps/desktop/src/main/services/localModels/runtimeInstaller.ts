import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AI_MAC_BUNDLE_VERSION, AI_RUNTIME_ASSET_IDS, AI_RUNTIME_PLATFORM_MESSAGE,
  aiRuntimeAssets, aiRuntimeTargetSupported, currentAiRuntimeTarget, type AiRuntimeAsset, type AiRuntimeTarget } from './runtimeManifest'
import { runLocalModelProcess } from './processRunner'
import { atomicWrite } from '../../utils/atomicWrite'
import type { LocalTranslationModelId } from '@shared/desktop/localModels'
import { localTranslationVersion } from './localTranslation'
import { extractPosixRuntime, safeRuntimePath } from './runtimeArchive'
import { ensureModelStore, ensureStorageDirectory, modelAssetDirectory, runtimeAssetDirectory, modelDownloadDirectory, modelDownloadFile, writeModelManifest } from './modelStorage'
import { AI_RUNTIME_LICENSES } from './runtimeLicenses'
import type { LocalRuntimeAcceleration } from './runtimeAcceleration'

export interface AiRuntimePaths {
  acceleration?: LocalRuntimeAcceleration
  whisper: string; translator: string; ffmpeg: string; ffprobe: string; kotoba: string; translationModel: string; vad: string
  asrVersion?: string
  translationVersion?: string
  translationModelId?: LocalTranslationModelId
}
export interface RuntimeInstallEvent {
  phase: 'checking' | 'downloading' | 'installing' | 'reused' | 'complete'
  networkBytes: number
  networkTotal: number
}
export function aiRuntimeHostSupported(target: AiRuntimeTarget, version?: string | null): boolean {
  if (!aiRuntimeTargetSupported(target)) return false
  if (version === undefined) return true
  const [major, minor] = (version ?? '').split('.').map(Number)
  if (target.platform === 'darwin') return Number.isFinite(major) && (major > 22 || (major === 22 && minor >= 4))
  if (target.platform === 'linux') return Number.isFinite(major) && (major > 2 || (major === 2 && minor >= 38))
  return true
}
function hostRuntimeVersion(): string | null | undefined {
  if (process.platform === 'darwin') return os.release()
  if (process.platform === 'linux') {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    return report?.header?.glibcVersionRuntime ?? null
  }
  return undefined
}
const runtimeHostVersion = hostRuntimeVersion()
export const localModelRuntimeSupported = (): boolean => aiRuntimeHostSupported(currentAiRuntimeTarget(), runtimeHostVersion)
async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}
/** Flatten only required tools, DLLs and license documents; never execute archive contents during install. */
const extractScript = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:JAVDEX_AI_ARCHIVE)
try {
  if ($archive.Entries.Count -gt 5000) { throw 'archive limit' }
  $total = 0
  foreach ($entry in $archive.Entries) {
    $total += $entry.Length
    if ($total -gt [long]$env:JAVDEX_AI_EXPANDED_LIMIT) { throw 'archive size limit' }
    $name = [IO.Path]::GetFileName($entry.FullName.Replace('\\','/'))
    if ($name -notmatch '^(whisper-cli|llama-server|ffmpeg|ffprobe)\\.exe$|\\.dll$|^(LICENSE|COPYING|NOTICE)') { continue }
    if ($entry.FullName -match '(^|[/\\\\])\\.\\.([/\\\\]|$)' -or ($entry.ExternalAttributes -shr 16 -band 61440) -eq 40960) { throw 'unsafe archive entry' }
    $target = [IO.Path]::Combine($env:JAVDEX_AI_DIRECTORY, $name)
    if ([IO.File]::Exists($target)) { throw 'duplicate archive entry' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
  }
} finally { $archive.Dispose() }`

interface RuntimeFile { name: string; sha256: string; bytes?: number }
async function runtimeFiles(directory: string, relative = ''): Promise<RuntimeFile[]> {
  const result: RuntimeFile[] = []
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (!safeRuntimePath(name) || entry.isSymbolicLink()) throw new Error('运行库文件路径不安全')
    if (entry.isDirectory()) result.push(...await runtimeFiles(directory, name))
    else if (entry.isFile() && name !== 'asset.json') result.push({ name, sha256: await hashFile(path.join(directory, name)), bytes: (await fs.stat(path.join(directory, name))).size })
    else if (!entry.isFile()) throw new Error('运行库包含不支持的文件')
  }
  return result
}
export function createAiRuntimeInstaller(root: string, download: typeof fetch = fetch, manifest?: readonly AiRuntimeAsset[], options: {
  target?: AiRuntimeTarget; bundleRoot?: string
} = {}) {
  const target = options.target ?? currentAiRuntimeTarget()
  const assets = manifest ?? aiRuntimeAssets(target)
  const windows = target.platform === 'win32', targetId = `${target.platform}-${target.arch}`
  const supported = (): boolean => options.target ? aiRuntimeTargetSupported(target) : localModelRuntimeSupported()
  const directory = root
  const toolDirectory = (id: AiRuntimeAsset['id']): string => runtimeAssetDirectory(root, id, target, assets.find(asset => asset.id === id)?.backend)
  const assetDirectory = (asset: AiRuntimeAsset): string => asset.archive ? toolDirectory(asset.id) : modelAssetDirectory(root, asset)
  const modelFile = (asset: AiRuntimeAsset): string => path.join(assetDirectory(asset), asset.filename)
  const requiredTools = (id: AiRuntimeAsset['id']): string[] => {
    if (id === 'cuda') return ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll']
    const names = id === 'ffmpeg' ? ['ffmpeg', 'ffprobe'] : [id === 'whisper' ? 'whisper-cli' : 'llama-server']
    return names.map(name => windows ? `${name}.exe` : target.platform === 'linux' && id === 'ffmpeg' ? `bin/${name}` : name)
  }
  const toolPath = (id: AiRuntimeAsset['id'], index = 0): string => path.join(toolDirectory(id), requiredTools(id)[index])
  const bundled = (id: AiRuntimeAsset['id']): boolean => (target.platform === 'darwin' && ['whisper', 'ffmpeg'].includes(id)) || !!assets.find(asset => asset.id === id)?.bundledVersion
  const bundleVersion = (id: AiRuntimeAsset['id']): string => assets.find(asset => asset.id === id)?.bundledVersion ?? AI_MAC_BUNDLE_VERSION
  const identity = (id: AiRuntimeAsset['id']): string | undefined => bundled(id) ? `${bundleVersion(id)}:${targetId}:${id}` : assets.find(asset => asset.id === id && asset.archive)?.sha256
  const paths = (): AiRuntimePaths => ({
    whisper: toolPath('whisper'), translator: toolPath('translator'), ffmpeg: toolPath('ffmpeg'), ffprobe: toolPath('ffmpeg', 1),
    kotoba: modelFile(assets.find(asset => asset.id === 'kotoba')!),
    translationModel: modelFile(assets.find(asset => asset.id === 'translation-model')!),
    vad: modelFile(assets.find(asset => asset.id === 'vad')!),
    asrVersion: assets.find(asset => asset.id === 'kotoba')!.sha256,
    translationModelId: assets.find(asset => asset.id === 'translation-model')!.translationModelId ?? 'qwen3',
    translationVersion: localTranslationVersion(assets.find(asset => asset.id === 'translation-model')!.translationModelId ?? 'qwen3',
      assets.find(asset => asset.id === 'translation-model')!.sha256)
  })
  async function validTools(id: AiRuntimeAsset['id'], fullHash = false): Promise<boolean> {
    try {
      if (!supported() || !identity(id)) return false
      const base = toolDirectory(id)
      if (!(await fs.lstat(base)).isDirectory()) return false
      const marker = JSON.parse(await fs.readFile(path.join(base, 'asset.json'), 'utf8'))
      if (marker.sha256 !== identity(id) || (marker.target && marker.target !== targetId)
        || !Array.isArray(marker.files) || !marker.files.length || marker.files.length > 5000) return false
      const names = new Set<string>()
      for (const entry of marker.files as RuntimeFile[]) {
        if (typeof entry.name !== 'string' || !safeRuntimePath(entry.name) || names.has(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256)) return false
        names.add(entry.name)
        const parts = entry.name.split('/')
        for (let i = 1; i < parts.length; i++) if (!(await fs.lstat(path.join(base, ...parts.slice(0, i)))).isDirectory()) return false
        const filename = path.join(base, entry.name), stat = await fs.lstat(filename)
        if (!stat.isFile() || (entry.bytes !== undefined && stat.size !== entry.bytes)) return false
        if (fullHash && await hashFile(filename) !== entry.sha256) return false
      }
      for (const name of requiredTools(id)) {
        // Cross-target inventories can be inspected on Windows, where stat has no POSIX executable bits.
        if (!names.has(name) || (!windows && process.platform !== 'win32' && !((await fs.stat(path.join(base, name))).mode & 0o111))) return false
      }
      if (assets.find(asset => asset.id === id)?.backend === 'cuda' && !names.has('NOTICE-CUDA.txt')) return false
      return true
    } catch { return false }
  }
  async function assetsInstalled(ids: readonly AiRuntimeAsset['id'][]): Promise<boolean> {
    try {
      for (const id of ids) {
        const asset = assets.find(asset => asset.id === id)
        if (bundled(id) || asset?.archive) {
          if (!await validTools(id)) return false
        } else {
          if (!asset) return false
          const stat = await fs.lstat(modelFile(asset))
          if (!stat.isFile() || stat.size !== asset.bytes) return false
        }
      }
      return true
    } catch { return false }
  }
  const installed = (): Promise<boolean> => assetsInstalled(AI_RUNTIME_ASSET_IDS)
  async function promoteTools(id: AiRuntimeAsset['id'], populate: (staging: string) => Promise<void>): Promise<void> {
    const destination = toolDirectory(id)
    await ensureStorageDirectory(root, path.dirname(destination))
    await ensureStorageDirectory(root, path.join(root, 'staging'))
    const staging = path.join(root, 'staging', `install-${randomUUID()}`), backup = path.join(root, 'staging', `install-${randomUUID()}`)
    await fs.mkdir(staging)
    try {
      await populate(staging)
      if (id === 'whisper' || id === 'translator') {
        await fs.writeFile(path.join(staging, 'LICENSE.txt'), AI_RUNTIME_LICENSES[id === 'whisper' ? 'Whisper-MIT.txt' : 'Llama-MIT.txt'])
      }
      if (assets.find(asset => asset.id === id)?.backend === 'cuda') {
        await fs.writeFile(path.join(staging, 'NOTICE-CUDA.txt'), 'NVIDIA CUDA Runtime / cuBLAS components are not covered by the engine MIT license.\nLicense: https://docs.nvidia.com/cuda/eula/index.html\nSource: pinned upstream distribution in gpuManifest.ts.\n')
      }
      for (const name of requiredTools(id)) {
        if (!(await fs.lstat(path.join(staging, name))).isFile()) throw new Error('运行库缺少必需工具')
        if (!windows) await fs.chmod(path.join(staging, name), 0o755)
      }
      const files = await runtimeFiles(staging)
      await atomicWrite(path.join(staging, 'asset.json'), JSON.stringify({ sha256: identity(id), target: targetId, files }))
      const previous = await fs.rename(destination, backup).then(() => true, error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      try { await fs.rename(staging, destination) }
      catch (error) { if (previous) await fs.rename(backup, destination); throw error }
      if (previous) await fs.rm(backup, { recursive: true, force: true })
    } finally { await fs.rm(staging, { recursive: true, force: true }) }
  }
  async function installBundled(id: AiRuntimeAsset['id'], signal: AbortSignal): Promise<void> {
    if (await validTools(id, true)) return
    const bundleRoot = options.bundleRoot ?? path.join(process.resourcesPath ?? '', 'ai-runtime')
    const suffix = assets.find(asset => asset.id === id)?.bundledVersion ? '-vulkan' : ''
    const source = path.join(bundleRoot, targetId + suffix)
    let bundle: { version: string; target: string; assets: Record<string, { files: RuntimeFile[] }> }
    try { bundle = JSON.parse(await fs.readFile(path.join(source, 'bundle.json'), 'utf8')) }
    catch { throw new Error(suffix ? '缺少 Vulkan 语音运行库；开发环境请运行 npm run ai-runtime:build -- --vulkan，正式版请重新安装应用' : '缺少 macOS AI 运行库；开发环境请先执行 npm run ai-runtime:build，正式版请重新安装应用') }
    const entries = bundle.assets?.[id]?.files
    if (bundle.version !== bundleVersion(id) || bundle.target !== targetId + suffix || !Array.isArray(entries) || !entries.length || entries.length > 100) throw new Error('AI 运行库清单无效')
    await promoteTools(id, async staging => {
      for (const entry of entries) {
        signal.throwIfAborted()
        if (!safeRuntimePath(entry.name) || path.posix.basename(entry.name) !== entry.name || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('AI 运行库清单不安全')
        const filename = path.join(source, id, entry.name), stat = await fs.lstat(filename)
        if (!stat.isFile() || stat.size !== entry.bytes || await hashFile(filename) !== entry.sha256) throw new Error('应用内置 AI 运行库完整性校验失败')
        await fs.copyFile(filename, path.join(staging, entry.name), 1)
      }
      signal.throwIfAborted()
    })
  }
  async function install(signal: AbortSignal, progress: (bytes: number, label: string) => void,
    ids: readonly AiRuntimeAsset['id'][] = AI_RUNTIME_ASSET_IDS, onEvent?: (event: RuntimeInstallEvent) => void): Promise<void> {
    if (!supported() && ids.some(id => ['whisper', 'translator', 'ffmpeg', 'cuda'].includes(id))) throw new Error(AI_RUNTIME_PLATFORM_MESSAGE)
    await ensureModelStore(root)
    let completed = 0
    for (const id of new Set(ids)) {
      signal.throwIfAborted()
      let networkBytes = 0, networkTotal = 0
      const emit = (phase: RuntimeInstallEvent['phase']): void => onEvent?.({ phase, networkBytes, networkTotal })
      emit('checking')
      if (bundled(id)) {
        if (await validTools(id, true)) emit('reused')
        else { emit('installing'); await installBundled(id, signal); emit('complete') }
        progress(completed, id === 'whisper' ? '日语识别运行库' : '音频提取运行库'); continue
      }
      const asset = assets.find(asset => asset.id === id)
      if (!asset) throw new Error('未知或缺失的本地模型资源')
      const targetDirectory = assetDirectory(asset)
      await ensureStorageDirectory(root, targetDirectory)
      const filename = modelFile(asset)
      if (asset.archive) {
        if (await validTools(id, true)) { completed += asset.bytes; progress(completed, asset.label); emit('reused'); continue }
      }
      if (!asset.archive && await fs.stat(filename).then(stat => stat.size === asset.bytes, () => false)
        && await hashFile(filename) === asset.sha256) {
        await writeModelManifest(root, asset)
        completed += asset.bytes; progress(completed, asset.label); emit('reused'); continue
      }
      const downloadDirectory = modelDownloadDirectory(root, asset)
      await ensureStorageDirectory(root, downloadDirectory)
      await atomicWrite(path.join(downloadDirectory, 'manifest.json'), JSON.stringify({ version: 1, sha256: asset.sha256, bytes: asset.bytes, filename: asset.filename, source: asset.url }))
      const partial = modelDownloadFile(root, asset)
      if (await fs.lstat(partial).then(stat => !stat.isFile() || stat.isSymbolicLink(), cause => { if (cause.code !== 'ENOENT') throw cause; return false })) throw new Error('模型下载临时文件无效')
      let received = await fs.stat(partial).then(stat => stat.size, () => 0)
      if (received > asset.bytes) { await fs.rm(partial, { force: true }); received = 0 }
      if (received !== asset.bytes) {
        networkTotal = asset.bytes - received; emit('downloading')
        const response = await download(asset.url, { signal, headers: received ? { Range: `bytes=${received}-` } : {} })
        if (!response.ok || !response.body) throw new Error(`${asset.label}下载失败（HTTP ${response.status}），请重试`)
        if (received && response.status !== 206) received = 0
        networkTotal = asset.bytes - received; emit('downloading')
        if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${received}-`)) throw new Error('模型下载续传范围不匹配')
        const file = await fs.open(partial, received ? 'a' : 'w', 0o600)
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            signal.throwIfAborted(); received += chunk.byteLength
            if (received > asset.bytes) throw new Error(`${asset.label}下载大小异常`)
            await file.write(chunk); networkBytes += chunk.byteLength; emit('downloading'); progress(completed + received, asset.label)
          }
        } finally { await file.close() }
      }
      emit('checking')
      if (received !== asset.bytes || await hashFile(partial) !== asset.sha256) {
        await fs.rm(partial, { force: true }); throw new Error(`${asset.label}完整性校验失败，请重试`)
      }
      signal.throwIfAborted()
      emit('installing')
      if (asset.archive) {
        await promoteTools(id, async expanded => {
          if (windows) await runLocalModelProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', extractScript], {
            signal, env: { ...process.env, JAVDEX_AI_ARCHIVE: partial, JAVDEX_AI_DIRECTORY: expanded,
              JAVDEX_AI_EXPANDED_LIMIT: String(asset.expandedBytes ?? 1024 ** 3) }
          })
          else {
            if (!asset.archivePrefix) throw new Error('运行库资源与当前平台不匹配')
            await extractPosixRuntime(partial, expanded, asset.archivePrefix, signal)
          }
          signal.throwIfAborted()
        })
        await fs.rm(partial, { force: true })
      } else { await fs.rename(partial, filename); await writeModelManifest(root, asset) }
      await fs.rm(downloadDirectory, { recursive: true, force: true })
      completed += asset.bytes; progress(completed, asset.label)
      emit('complete')
    }
  }
  async function assetPresent(id: AiRuntimeAsset['id']): Promise<boolean> {
    const asset = assets.find(asset => asset.id === id)
    if (!asset && !bundled(id)) throw new Error('未知本地模型')
    const locations = [asset?.archive || bundled(id) ? toolDirectory(id) : assetDirectory(asset!)]
    if (asset && !bundled(id)) locations.push(modelDownloadDirectory(root, asset))
    for (const location of locations) {
      const stat = await fs.lstat(location).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null })
      if (stat && (!stat.isDirectory() || (await fs.readdir(location)).length > 0)) return true
    }
    return false
  }
  return { directory, installed, assetsInstalled, assetPresent, install, paths, modelFile,
    async removeAsset(id: AiRuntimeAsset['id']): Promise<void> {
      const asset = assets.find(asset => asset.id === id)
      if (!asset && !bundled(id)) throw new Error('未知本地模型')
      const destination = asset?.archive || bundled(id) ? toolDirectory(id) : assetDirectory(asset!)
      const download = asset && !bundled(id) ? modelDownloadDirectory(root, asset) : undefined
      // Validate every target before removing anything, including archived runtime resume data.
      await ensureStorageDirectory(root, destination)
      if (download) await ensureStorageDirectory(root, download)
      await fs.rm(destination, { recursive: true, force: true })
      if (download) await fs.rm(download, { recursive: true, force: true })
    },
    async remove(): Promise<void> {
      await ensureModelStore(root)
      for (const entry of ['models', 'runtimes', 'downloads', 'staging']) {
        await ensureStorageDirectory(root, path.join(root, entry))
        await fs.rm(path.join(root, entry), { recursive: true, force: true })
      }
    }
  }
}
