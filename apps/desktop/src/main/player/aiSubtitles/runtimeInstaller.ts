import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { AI_SUBTITLE_ASSETS, AI_SUBTITLE_RUNTIME_VERSION, type AiRuntimeAsset } from './runtimeManifest'
import { runSubtitleProcess } from './processRunner'
import { atomicWrite } from './subtitleCache'
import { AI_RUNTIME_LICENSES } from './runtimeLicenses'

export interface AiRuntimePaths { whisper: string; translator: string; ffmpeg: string; ffprobe: string; kotoba: string; translationModel: string; vad: string }
const executables = ['whisper-cli.exe', 'llama-server.exe', 'ffmpeg.exe', 'ffprobe.exe']
export const aiSubtitleSupported = (): boolean => process.platform === 'win32' && process.arch === 'x64'
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
    if ($total -gt 1073741824) { throw 'archive size limit' }
    $name = [IO.Path]::GetFileName($entry.FullName.Replace('\\','/'))
    if ($name -notmatch '^(whisper-cli|llama-server|ffmpeg|ffprobe)\\.exe$|\\.dll$|^(LICENSE|COPYING|NOTICE)') { continue }
    if ($entry.FullName -match '(^|[/\\\\])\\.\\.([/\\\\]|$)' -or ($entry.ExternalAttributes -shr 16 -band 61440) -eq 40960) { throw 'unsafe archive entry' }
    $target = [IO.Path]::Combine($env:JAVDEX_AI_DIRECTORY, $name)
    if ([IO.File]::Exists($target)) { throw 'duplicate archive entry' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
  }
} finally { $archive.Dispose() }`

export function createAiRuntimeInstaller(root: string, download: typeof fetch = fetch) {
  const directory = path.join(root, AI_SUBTITLE_RUNTIME_VERSION)
  const assetDirectory = (asset: AiRuntimeAsset): string => path.join(directory, asset.id)
  const modelFile = (asset: AiRuntimeAsset): string => path.join(assetDirectory(asset), asset.filename)
  const paths = (): AiRuntimePaths => ({
    whisper: path.join(directory, 'whisper', executables[0]), translator: path.join(directory, 'translator', executables[1]),
    ffmpeg: path.join(directory, 'ffmpeg', executables[2]), ffprobe: path.join(directory, 'ffmpeg', executables[3]),
    kotoba: modelFile(AI_SUBTITLE_ASSETS[3]), translationModel: modelFile(AI_SUBTITLE_ASSETS[4]), vad: modelFile(AI_SUBTITLE_ASSETS[5])
  })
  async function assetsInstalled(ids: readonly AiRuntimeAsset['id'][]): Promise<boolean> {
    if (!aiSubtitleSupported()) return false
    try {
      for (const asset of AI_SUBTITLE_ASSETS.filter(asset => ids.includes(asset.id))) {
        if (asset.archive) {
          const required = asset.id === 'ffmpeg' ? [executables[2], executables[3]] : [asset.id === 'whisper' ? executables[0] : executables[1]]
          for (const name of required) if (!(await fs.stat(path.join(assetDirectory(asset), name))).isFile()) return false
        } else if ((await fs.stat(modelFile(asset))).size !== asset.bytes) return false
      }
      return true
    } catch { return false }
  }
  const installed = (): Promise<boolean> => assetsInstalled(AI_SUBTITLE_ASSETS.map(asset => asset.id))
  async function install(signal: AbortSignal, progress: (bytes: number, label: string) => void,
    ids: readonly AiRuntimeAsset['id'][] = AI_SUBTITLE_ASSETS.map(asset => asset.id)): Promise<void> {
    if (!aiSubtitleSupported()) throw new Error('离线 AI 字幕当前支持 Windows x64')
    await fs.mkdir(directory, { recursive: true })
    let completed = 0
    for (const asset of AI_SUBTITLE_ASSETS.filter(asset => ids.includes(asset.id))) {
      signal.throwIfAborted()
      const targetDirectory = assetDirectory(asset)
      await fs.mkdir(targetDirectory, { recursive: true })
      const filename = modelFile(asset)
      if (asset.archive) {
        try {
          const marker = JSON.parse(await fs.readFile(path.join(targetDirectory, 'asset.json'), 'utf8'))
          if (marker.sha256 === asset.sha256 && Array.isArray(marker.files) && marker.files.length > 0) {
            let valid = true
            for (const entry of marker.files) {
              if (typeof entry.name !== 'string' || path.basename(entry.name) !== entry.name
                || await hashFile(path.join(targetDirectory, entry.name)) !== entry.sha256) { valid = false; break }
            }
            if (valid) { completed += asset.bytes; progress(completed, asset.label); continue }
          }
        } catch { /* Missing or damaged tools are installed again from the pinned release. */ }
      }
      if (!asset.archive && await fs.stat(filename).then(stat => stat.size === asset.bytes, () => false)
        && await hashFile(filename) === asset.sha256) {
        completed += asset.bytes; progress(completed, asset.label); continue
      }
      const partial = `${filename}.part`
      let received = await fs.stat(partial).then(stat => stat.size, () => 0)
      if (received > asset.bytes) { await fs.rm(partial, { force: true }); received = 0 }
      if (received !== asset.bytes) {
        const response = await download(asset.url, { signal, headers: received ? { Range: `bytes=${received}-` } : {} })
        if (!response.ok || !response.body) throw new Error(`${asset.label}下载失败，请重试`)
        if (received && response.status !== 206) received = 0
        if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${received}-`)) throw new Error('模型下载续传范围不匹配')
        const file = await fs.open(partial, received ? 'a' : 'w', 0o600)
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            signal.throwIfAborted(); received += chunk.byteLength
            if (received > asset.bytes) throw new Error(`${asset.label}下载大小异常`)
            await file.write(chunk); progress(completed + received, asset.label)
          }
        } finally { await file.close() }
      }
      if (received !== asset.bytes || await hashFile(partial) !== asset.sha256) {
        await fs.rm(partial, { force: true }); throw new Error(`${asset.label}完整性校验失败，请重试`)
      }
      signal.throwIfAborted()
      if (asset.archive) {
        const expanded = path.join(targetDirectory, 'expanded')
        await fs.rm(expanded, { recursive: true, force: true }); await fs.mkdir(expanded)
        await runSubtitleProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', extractScript], {
          signal, env: { ...process.env, JAVDEX_AI_ARCHIVE: partial, JAVDEX_AI_DIRECTORY: expanded }
        })
        for (const entry of await fs.readdir(expanded)) await fs.rename(path.join(expanded, entry), path.join(targetDirectory, entry))
        await fs.rm(expanded, { recursive: true, force: true }); await fs.rm(partial, { force: true })
        const files = await Promise.all((await fs.readdir(targetDirectory)).filter(name => name !== 'asset.json').map(async name => ({ name, sha256: await hashFile(path.join(targetDirectory, name)) })))
        await atomicWrite(path.join(targetDirectory, 'asset.json'), JSON.stringify({ sha256: asset.sha256, files }))
      } else await fs.rename(partial, filename)
      completed += asset.bytes; progress(completed, asset.label)
    }
    for (const [name, license] of Object.entries(AI_RUNTIME_LICENSES)) await atomicWrite(path.join(directory, name), license)
    await atomicWrite(path.join(directory, 'NOTICE.txt'), 'Offline AI subtitles\nKotoba-Whisper v2.0: Apache-2.0\nhttps://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml\nQwen3-1.7B: Apache-2.0; quantization by bartowski\nhttps://huggingface.co/Qwen/Qwen3-1.7B\nhttps://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF\nSilero VAD: MIT\nhttps://github.com/snakers4/silero-vad\nwhisper.cpp and llama.cpp: MIT\nFFmpeg LGPL shared build: license files in ffmpeg directory\n')
    if (await installed()) await atomicWrite(path.join(directory, 'installed.json'), JSON.stringify({ version: AI_SUBTITLE_RUNTIME_VERSION }))
  }
  return { directory, installed, assetsInstalled, install, paths,
    async removeAsset(id: AiRuntimeAsset['id']): Promise<void> {
      if (!AI_SUBTITLE_ASSETS.some(asset => asset.id === id)) throw new Error('未知本地模型')
      await fs.rm(path.join(directory, id), { recursive: true, force: true })
      await fs.rm(path.join(directory, 'installed.json'), { force: true })
    },
    async remove(): Promise<void> { await fs.rm(directory, { recursive: true, force: true }) }
  }
}
