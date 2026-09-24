import { IPC } from '@shared/ipc-channels'
import { fetchRemoteImagePreview } from '../services/remoteImageService'
import { appCommandAdapter } from './appContractAdapter'

export function registerAssetHandlers(): void {
  appCommandAdapter.register(IPC.ASSET_FETCH_REMOTE_IMAGE, async (url) => {
    const trimmed = url?.trim()
    if (!trimmed) throw new Error('请输入有效的图片链接')
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error('请输入有效的图片链接')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('只支持 http 或 https 图片链接')
    }
    return fetchRemoteImagePreview(parsed.toString())
  })
}
