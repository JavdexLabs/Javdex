import type { ActressGalleryAsset, ActressGalleryImportInput } from '@shared/types'
import {
  addActressGalleryAsset,
  deleteActressGalleryAsset,
  getActressDetail
} from '../db/actressRepo'
import {
  deleteAsset,
  downloadActressGalleryImage,
  importActressGalleryFromFile,
  readImageDimensionsFromPath,
  readImageDimensionsFromRelPath
} from './assetService'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'

export async function importActressGalleryImage(
  actressId: number,
  input: ActressGalleryImportInput
): Promise<ActressGalleryAsset> {
  const actress = getActressDetail(actressId)
  if (!actress) throw new Error('演员不存在')

  if (input.source === 'file') {
    const sourcePath = input.sourcePath?.trim()
    if (!sourcePath) throw new Error('请选择本地图片文件')
    const localPath = importActressGalleryFromFile(actress.main_name, sourcePath)
    const dims =
      readImageDimensionsFromRelPath(localPath) ?? readImageDimensionsFromPath(sourcePath)
    return addActressGalleryAsset(actressId, {
      localPath,
      width: dims?.width ?? null,
      height: dims?.height ?? null
    })
  }

  const rawUrl = input.remoteUrl?.trim()
  if (!rawUrl) throw new Error('请输入写真链接')
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('写真链接格式不正确')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('写真链接仅支持 http/https')
  }

  const remoteUrl = parsed.toString()
  const downloaded = await downloadActressGalleryImage(actress.main_name, remoteUrl, (url) =>
    scrapeBrowser.fetchBuffer(url)
  )
  if (!downloaded) throw new Error('写真链接下载失败')
  return addActressGalleryAsset(actressId, {
    remoteUrl,
    localPath: downloaded.localPath,
    width: downloaded.width,
    height: downloaded.height
  })
}

export function deleteActressGalleryImage(actressId: number, assetId: number): void {
  const localPath = deleteActressGalleryAsset(actressId, assetId)
  deleteAsset(localPath)
}
