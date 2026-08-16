import type { ClassificationImageInput } from '@shared/classificationTypes'

export function classificationImageDisplayState(
  imagePath: string | null,
  fallbackCoverPath: string | null
): { path: string | null; label: '正式主图' | '动态回退' | '暂无图片' } {
  if (imagePath) return { path: imagePath, label: '正式主图' }
  if (fallbackCoverPath) return { path: fallbackCoverPath, label: '动态回退' }
  return { path: null, label: '暂无图片' }
}

export function fileClassificationImageInput(sourcePath: string): ClassificationImageInput | null {
  const path = sourcePath.trim()
  return path ? { source: 'file', sourcePath: path } : null
}

export function remoteClassificationImageInput(remoteUrl: string): ClassificationImageInput | null {
  const url = remoteUrl.trim()
  return url ? { source: 'url', remoteUrl: url } : null
}

export function videoCoverClassificationImageInput(videoId: number): ClassificationImageInput {
  return { source: 'video-cover', videoId }
}
