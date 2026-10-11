import type { PlaybackOcclusion } from '@shared/desktop/playback'

type Rectangle = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>
interface Occluder {
  ownerDocument?: Document
  checkVisibility(options?: CheckVisibilityOptions): boolean
  getBoundingClientRect(): Rectangle
}

/** Native child windows cannot be covered by HTML z-index. Visual occlusion is
 * independent of keyboard/modal ownership and only hides an intersected view. */
export function playbackOcclusions(video: Rectangle, occluders: Iterable<Occluder>): PlaybackOcclusion[] {
  const result: PlaybackOcclusion[] = []
  if (video.right <= video.left || video.bottom <= video.top) return result
  for (const element of occluders) {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const bounds = element.getBoundingClientRect()
    if (bounds.right > bounds.left && bounds.bottom > bounds.top
      && bounds.left < video.right && bounds.right > video.left
      && bounds.top < video.bottom && bounds.bottom > video.top) {
      const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top
      const style = element.ownerDocument?.defaultView?.getComputedStyle(element as Element)
      const radii = style ? [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
        .map(value => Math.max(0, Math.min(width / 2, height / 2, value.endsWith('%') ? parseFloat(value) * Math.min(width, height) / 100 : parseFloat(value) || 0))) as PlaybackOcclusion['radii'] : undefined
      if (radii?.some(radius => radius > 0)) {
        // Clipping the bounds first would move the rounded corners to the video edge.
        result.push({ x: bounds.left, y: bounds.top, width, height, radii })
      } else {
        const x = Math.max(video.left, bounds.left), y = Math.max(video.top, bounds.top)
        result.push({ x, y, width: Math.min(video.right, bounds.right) - x, height: Math.min(video.bottom, bounds.bottom) - y })
      }
    }
  }
  return result
}
export function hasPlaybackOcclusion(video: Rectangle, occluders: Iterable<Occluder>): boolean {
  return playbackOcclusions(video, occluders).length > 0
}
