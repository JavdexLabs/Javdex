import type { VideoResourceFilter, VideoResourceKind } from '@shared/videoTypes'

export const VIDEO_RESOURCE_KIND_LABELS: Record<VideoResourceKind, string> = {
  local: '本地文件',
  direct: '视频直链',
  web: '网页链接',
  magnet: 'Magnet',
  ed2k: 'ED2K'
}

export const VIDEO_RESOURCE_KIND_BADGE_LABELS: Record<VideoResourceKind, string> = {
  local: '本地',
  direct: '直链',
  web: '网页',
  magnet: 'Magnet',
  ed2k: 'ED2K'
}

export const VIDEO_RESOURCE_FILTER_LABELS: Record<VideoResourceFilter, string> = {
  ...VIDEO_RESOURCE_KIND_LABELS,
  none: '无资源'
}
