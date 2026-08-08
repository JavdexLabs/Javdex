import type { ActressGalleryAsset, ActressGalleryImportInput } from '@shared/actressTypes'
import {
  addActressGalleryAsset,
  deleteActressGalleryAsset,
  getActressDetail
} from '../db/actressRepo'
import { mediaAssetStore } from './mediaAssetStore'
import { fetchRemoteImageBuffer } from './remoteImageFetch'

export async function importActressGalleryImage(
  actressId: number,
  input: ActressGalleryImportInput
): Promise<ActressGalleryAsset> {
  const actress = getActressDetail(actressId)
  if (!actress) throw new Error('演员不存在')

  if (input.source === 'file') {
    const sourcePath = input.sourcePath?.trim()
    if (!sourcePath) throw new Error('请选择本地图片文件')
    const localPath = mediaAssetStore.importActressGallery(
      actress.main_name,
      sourcePath,
      actressId
    )
    const dims =
      mediaAssetStore.readStoredImageDimensions(localPath) ??
      mediaAssetStore.readImageDimensionsAtPath(sourcePath)
    try {
      return addActressGalleryAsset(actressId, {
        localPath,
        width: dims?.width ?? null,
        height: dims?.height ?? null
      })
    } catch (error) {
      mediaAssetStore.deleteBestEffort(localPath)
      throw error
    }
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
  const buf = await fetchRemoteImageBuffer(remoteUrl)
  const downloaded = await mediaAssetStore.downloadActressGalleryImage(
    actress.main_name,
    remoteUrl,
    async () => buf,
    actressId
  )
  if (!downloaded) throw new Error('写真链接下载失败')
  try {
    return addActressGalleryAsset(actressId, {
      remoteUrl,
      localPath: downloaded.localPath,
      width: downloaded.width,
      height: downloaded.height
    })
  } catch (error) {
    mediaAssetStore.deleteBestEffort(downloaded.localPath)
    throw error
  }
}

export function deleteActressGalleryImage(actressId: number, assetId: number): void {
  const localPath = deleteActressGalleryAsset(actressId, assetId)
  mediaAssetStore.deleteBestEffort(localPath)
}
