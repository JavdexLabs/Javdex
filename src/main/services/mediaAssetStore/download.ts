import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildActressAssetSeed } from '../assetPathNaming'
import {
  assetsRoot,
  writeImageAsset
} from './filesystem'
import {
  detectImageExtensionFromBuffer,
  isUsableImageBuffer,
  readImageDimensionsFromBuffer
} from './imageBytes'
import { readImageDimensionsFromRelPath } from './inspection'
import type { AssetFetcher, DownloadedImageAsset } from './types'

const ACTRESS_SCRAPE_STAGING_DIRNAME = '.actress_scrape_staging'
const DEFAULT_STAGING_ORPHAN_SAFETY_AGE_MS = 24 * 60 * 60 * 1000

export interface ActressScrapeStagingInput {
  field: 'avatar' | 'gallery'
  position: number
  remoteUrl?: string
  data: Buffer
  width?: number | null
  height?: number | null
}

export interface StagedActressScrapeImage {
  field: 'avatar' | 'gallery'
  position: number
  remoteUrl?: string
  stagedPath: string
  width: number | null
  height: number | null
}

function extFromUrl(url: string): string {
  const clean = url.split('?')[0]
  const ext = path.extname(clean).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext)) return ext
  return '.jpg'
}

export async function downloadCover(
  code: string,
  url: string,
  fetcher: AssetFetcher
): Promise<string | null> {
  try {
    const ext = extFromUrl(url)
    const buf = await fetcher(url)
    if (!isUsableImageBuffer(buf)) throw new Error('response is not a usable image')
    return writeImageAsset('covers', code, url, ext, buf)
  } catch (err) {
    console.error('downloadCover failed:', code, url, (err as Error).message)
    return null
  }
}

export async function downloadAvatar(
  name: string,
  url: string,
  fetcher: AssetFetcher
): Promise<string | null> {
  try {
    const ext = extFromUrl(url)
    const buf = await fetcher(url)
    if (!isUsableImageBuffer(buf)) throw new Error('response is not a usable image')
    // Name-hash seed only: actress id may not exist yet; adopt later scopes permanent files.
    return writeImageAsset('avatars', buildActressAssetSeed(name), url, ext, buf)
  } catch (err) {
    console.error('downloadAvatar failed:', name, url, (err as Error).message)
    return null
  }
}

export function storeScrapedActressAvatar(name: string, url: string, data: Buffer): string {
  if (!isUsableImageBuffer(data)) throw new Error('头像不是可用图片')
  const ext = detectImageExtensionFromBuffer(data) ?? extFromUrl(url)
  return writeImageAsset(
    'avatars',
    buildActressAssetSeed(name),
    `${url}\0${randomUUID()}`,
    ext,
    data
  )
}

export function storeScrapedActressGalleryImage(
  name: string,
  actressId: number,
  url: string,
  data: Buffer
): DownloadedImageAsset {
  if (!isUsableImageBuffer(data)) throw new Error('写真不是可用图片')
  const ext = detectImageExtensionFromBuffer(data) ?? extFromUrl(url)
  const localPath = writeImageAsset(
    'actress_gallery',
    buildActressAssetSeed(name, actressId),
    `${url}\0${randomUUID()}`,
    ext,
    data
  )
  const dimensions = readImageDimensionsFromBuffer(data)
  return {
    localPath,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null
  }
}

export async function downloadActressGalleryImage(
  name: string,
  url: string,
  fetcher: AssetFetcher,
  actressId?: number | null
): Promise<DownloadedImageAsset | null> {
  try {
    const ext = extFromUrl(url)
    const buf = await fetcher(url)
    if (!isUsableImageBuffer(buf)) throw new Error('response is not a usable image')
    const localPath = writeImageAsset(
      'actress_gallery',
      buildActressAssetSeed(name, actressId),
      url,
      ext,
      buf
    )
    const dims =
      readImageDimensionsFromRelPath(localPath) ?? readImageDimensionsFromBuffer(buf)
    return {
      localPath,
      width: dims?.width ?? null,
      height: dims?.height ?? null
    }
  } catch (err) {
    console.error('downloadActressGalleryImage failed:', name, url, (err as Error).message)
    return null
  }
}

export async function downloadSamples(
  code: string,
  urls: string[],
  fetcher: AssetFetcher
): Promise<Array<string | null>> {
  const out: Array<string | null> = []
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index]
    try {
      const ext = extFromUrl(url)
      const buf = await fetcher(url)
      if (!isUsableImageBuffer(buf)) throw new Error('response is not a usable image')
      out.push(writeImageAsset('samples', `${code}_${index}`, url, ext, buf))
    } catch (err) {
      console.error('downloadSamples failed:', code, index, url, (err as Error).message)
      out.push(null)
    }
  }
  return out
}

function actressScrapeStagingRoot(): string {
  return path.resolve(assetsRoot(), ACTRESS_SCRAPE_STAGING_DIRNAME)
}

function resolveActressScrapeStagedPath(stagedPath: string): string {
  const stagingRoot = actressScrapeStagingRoot()
  const absolutePath = path.resolve(assetsRoot(), stagedPath)
  const relative = path.relative(stagingRoot, absolutePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('待确认暂存资源路径无效')
  }
  return absolutePath
}

export function stageActressScrapeImages(
  resources: ActressScrapeStagingInput[]
): StagedActressScrapeImage[] {
  if (resources.length === 0) return []
  const token = randomUUID()
  const relativeDir = path.posix.join(ACTRESS_SCRAPE_STAGING_DIRNAME, token)
  const absoluteDir = path.join(actressScrapeStagingRoot(), token)
  fs.mkdirSync(absoluteDir, { recursive: true })
  const staged: StagedActressScrapeImage[] = []
  try {
    for (const resource of resources) {
      if (!isUsableImageBuffer(resource.data)) throw new Error('暂存资源不是可用图片')
      const extension = detectImageExtensionFromBuffer(resource.data) ?? '.jpg'
      const filename = `${resource.field}-${resource.position}${extension}`
      fs.writeFileSync(path.join(absoluteDir, filename), resource.data)
      staged.push({
        field: resource.field,
        position: resource.position,
        ...(resource.remoteUrl?.trim() ? { remoteUrl: resource.remoteUrl.trim() } : {}),
        stagedPath: path.posix.join(relativeDir, filename),
        width: resource.width ?? null,
        height: resource.height ?? null
      })
    }
    return staged
  } catch (error) {
    fs.rmSync(absoluteDir, { recursive: true, force: true })
    throw error
  }
}

export function readActressScrapeStagedImage(stagedPath: string): Buffer {
  const data = fs.readFileSync(resolveActressScrapeStagedPath(stagedPath))
  if (!isUsableImageBuffer(data)) throw new Error('待确认暂存资源不可用')
  return data
}

export function cleanupActressScrapeStagingPaths(stagedPaths: string[]): void {
  const directories = new Set<string>()
  for (const stagedPath of stagedPaths) {
    try {
      directories.add(path.dirname(resolveActressScrapeStagedPath(stagedPath)))
    } catch {
      continue
    }
  }
  for (const directory of directories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      console.error('cleanup staged actress scrape resources failed:', (error as Error).message)
    }
  }
}

export function cleanupOrphanedActressScrapeStaging(
  referencedPaths: string[],
  options?: { now?: number; olderThanMs?: number }
): number {
  const stagingRoot = actressScrapeStagingRoot()
  if (!fs.existsSync(stagingRoot)) return 0
  const referencedDirectories = new Set<string>()
  for (const stagedPath of referencedPaths) {
    try {
      referencedDirectories.add(path.dirname(resolveActressScrapeStagedPath(stagedPath)))
    } catch {
      continue
    }
  }
  const now = options?.now ?? Date.now()
  const olderThanMs = options?.olderThanMs ?? DEFAULT_STAGING_ORPHAN_SAFETY_AGE_MS
  let removed = 0
  for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.resolve(stagingRoot, entry.name)
    const relative = path.relative(stagingRoot, directory)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    if (referencedDirectories.has(directory)) continue
    if (now - fs.statSync(directory).mtimeMs < olderThanMs) continue
    fs.rmSync(directory, { recursive: true, force: true })
    removed += 1
  }
  return removed
}
