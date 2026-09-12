import type { VideoResourceKind } from '@shared/videoTypes'
import { VIDEO_RESOURCE_KIND_BADGE_LABELS } from './videoResourcePresentation'

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
      label: VIDEO_RESOURCE_KIND_BADGE_LABELS[kind]
    })),
    overflow: Math.max(0, uniqueKinds.length - 2),
    title: uniqueKinds.map((kind) => VIDEO_RESOURCE_KIND_BADGE_LABELS[kind]).join('、')
  }
}
