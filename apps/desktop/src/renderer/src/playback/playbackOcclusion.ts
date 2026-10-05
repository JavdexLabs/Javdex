type Rectangle = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>
interface Occluder {
  checkVisibility(options?: CheckVisibilityOptions): boolean
  getBoundingClientRect(): Rectangle
}

/** Native child windows cannot be covered by HTML z-index. Visual occlusion is
 * independent of keyboard/modal ownership and only hides an intersected view. */
export function playbackOcclusions(video: Rectangle, occluders: Iterable<Occluder>): Array<{ x: number; y: number; width: number; height: number }> {
  const result: Array<{ x: number; y: number; width: number; height: number }> = []
  if (video.right <= video.left || video.bottom <= video.top) return result
  for (const element of occluders) {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const bounds = element.getBoundingClientRect()
    if (bounds.right > bounds.left && bounds.bottom > bounds.top
      && bounds.left < video.right && bounds.right > video.left
      && bounds.top < video.bottom && bounds.bottom > video.top) {
      const x = Math.max(video.left, bounds.left), y = Math.max(video.top, bounds.top)
      result.push({ x, y, width: Math.min(video.right, bounds.right) - x, height: Math.min(video.bottom, bounds.bottom) - y })
    }
  }
  return result
}
export function hasPlaybackOcclusion(video: Rectangle, occluders: Iterable<Occluder>): boolean {
  return playbackOcclusions(video, occluders).length > 0
}
