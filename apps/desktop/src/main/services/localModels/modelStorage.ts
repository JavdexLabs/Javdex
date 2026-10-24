import fs from 'node:fs/promises'
import path from 'node:path'
import type { AiRuntimeAsset, AiRuntimeTarget } from './runtimeManifest'
import { atomicWrite } from '../../utils/atomicWrite'
import { AI_RUNTIME_LICENSES } from './runtimeLicenses'
import { LOCAL_MODEL_NOTICES } from './modelNotices'

export const MODEL_STORE_ENTRIES = ['models', 'runtimes', 'downloads', 'store.json'] as const
/** Resolve existing ancestors without creating a rejected relocation target. */
export async function canonicalStoragePath(file: string): Promise<string> {
  try { return await fs.realpath(file) }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    const parent = path.dirname(file)
    if (parent === file) throw cause
    return path.join(await canonicalStoragePath(parent), path.basename(file))
  }
}
const marker = { kind: 'javdex-local-ai', version: 1 }
function component(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value === '..') throw new Error('本地模型存储身份无效')
  return value
}
export function localAiDirectories(userData: string, platform: string = process.platform, env = process.env) {
  // Test/acceptance profiles and custom application profiles must remain isolated.
  const standardWindowsProfile = platform === 'win32' && env.APPDATA
    && path.resolve(userData).toLowerCase() === path.resolve(env.APPDATA, 'Javdex').toLowerCase()
  const base = standardWindowsProfile && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Javdex') : userData
  return { store: path.join(base, 'local-ai'), cache: path.join(base, 'cache', 'ai-subtitles'), work: path.join(base, 'cache', 'local-ai', 'work', 'ai-subtitles') }
}
export function modelAssetDirectory(root: string, asset: AiRuntimeAsset): string {
  if (!asset.model) throw new Error('本地模型缺少存储身份')
  const { family, publisher, revision, precision } = asset.model
  return path.join(root, 'models', ...[family, publisher, revision, precision].map(component))
}
export function runtimeAssetDirectory(root: string, id: AiRuntimeAsset['id'], target: AiRuntimeTarget, backend = 'cpu'): string {
  const runtime = id === 'whisper' ? ['whisper.cpp', 'b5130'] : ['translator', 'cuda'].includes(id) ? ['llama.cpp', 'b11435'] : ['ffmpeg', '8.1.3-r1']
  return path.join(root, 'runtimes', ...runtime, component(`${target.platform}-${target.arch}${id === 'ffmpeg' ? '' : `-${backend}${id === 'cuda' ? '-dependencies' : ''}`}`))
}
export function modelDownloadDirectory(root: string, asset: AiRuntimeAsset): string {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('本地模型下载身份无效')
  return path.join(root, 'downloads', asset.sha256)
}
export function modelDownloadFile(root: string, asset: AiRuntimeAsset): string {
  return path.join(modelDownloadDirectory(root, asset), `${component(asset.filename)}.part`)
}
/** Never follow a junction/symlink inside the managed tree, including cleanup paths. */
export async function ensureStorageDirectory(root: string, destination = root): Promise<void> {
  const relative = path.relative(root, destination)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('本地模型路径超出保存目录')
  await fs.mkdir(root, { recursive: true })
  if (!(await fs.lstat(root)).isDirectory() || (await fs.lstat(root)).isSymbolicLink()) throw new Error('模型保存目录不能是链接')
  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    await fs.mkdir(current).catch(cause => { if (cause.code !== 'EEXIST') throw cause })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('模型目录包含不支持的链接或文件')
  }
}
export async function ensureModelStore(root: string): Promise<void> {
  await ensureStorageDirectory(root)
  const file = path.join(root, 'store.json')
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('模型保存目录标识无效')
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (value.kind !== marker.kind || value.version !== marker.version) throw new Error('模型保存目录标识无效')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    await atomicWrite(file, JSON.stringify(marker))
  }
}
export async function writeModelManifest(root: string, asset: AiRuntimeAsset): Promise<void> {
  const directory = modelAssetDirectory(root, asset)
  await ensureStorageDirectory(root, directory)
  await atomicWrite(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, ...asset.model,
    filename: asset.filename, sha256: asset.sha256, bytes: asset.bytes, source: asset.url }, null, 2))
  await atomicWrite(path.join(directory, 'LICENSE.txt'), asset.id === 'vad' ? AI_RUNTIME_LICENSES['Silero-MIT.txt'] : AI_RUNTIME_LICENSES['Apache-2.0.txt'])
  await atomicWrite(path.join(directory, 'NOTICE.txt'), asset.translationModelId === 'hy-mt2-7b' ? LOCAL_MODEL_NOTICES['hy-mt2-7b'] : `${asset.label}\nSource: ${asset.url}\n`)
}
export async function cleanModelTemporaryFiles(root: string, allDownloads = false, now = Date.now()): Promise<void> {
  await ensureModelStore(root)
  for (const group of ['staging', 'downloads']) {
    const directory = path.join(root, group)
    await ensureStorageDirectory(root, directory)
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (group === 'downloads' ? !/^[a-f0-9]{64}$/.test(entry.name) : !/^(install|import)-[a-f0-9-]{36}$/.test(entry.name)) continue
      const item = path.join(directory, entry.name), stat = await fs.stat(item)
      const age = now - stat.mtimeMs
      // Downloads retain resume data for seven days. Active tasks call this only before starting.
      if ((group === 'downloads' && allDownloads) || age > (group === 'downloads' ? 7 : 1) * 86400000) {
        await fs.rm(item, { recursive: true, force: true })
      }
    }
  }
}
