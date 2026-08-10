import type { VideoResourceKind } from '@shared/videoTypes'

export const VIDEO_RESOURCE_KIND_LABELS: Record<VideoResourceKind, string> = {
  local: '本地',
  direct: '直链',
  web: '网页',
  magnet: 'Magnet',
  ed2k: 'ED2K'
}

export interface VideoResourceBadgeSummary {
  visible: Array<{ kind: VideoResourceKind; label: string }>
  overflow: number
  title: string
}

export function getVideoResourceBadgeSummary(
  resourceKinds: VideoResourceKind[]
): VideoResourceBadgeSummary {
  const uniqueKinds = Array.from(new Set(resourceKinds))
  return {
    visible: uniqueKinds.slice(0, 2).map((kind) => ({
      kind,
      label: VIDEO_RESOURCE_KIND_LABELS[kind]
    })),
    overflow: Math.max(0, uniqueKinds.length - 2),
    title: uniqueKinds.map((kind) => VIDEO_RESOURCE_KIND_LABELS[kind]).join('、')
  }
}
