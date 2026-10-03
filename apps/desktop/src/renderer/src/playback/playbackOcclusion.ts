type Rectangle = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>
interface Occluder {
  checkVisibility(options?: CheckVisibilityOptions): boolean
  getBoundingClientRect(): Rectangle
}

/** Native child windows cannot be covered by HTML z-index. Visual occlusion is
 * independent of keyboard/modal ownership and only hides an intersected view. */
export function hasPlaybackOcclusion(video: Rectangle, occluders: Iterable<Occluder>): boolean {
  if (video.right <= video.left || video.bottom <= video.top) return false
  for (const element of occluders) {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const bounds = element.getBoundingClientRect()
    if (bounds.right > bounds.left && bounds.bottom > bounds.top
      && bounds.left < video.right && bounds.right > video.left
      && bounds.top < video.bottom && bounds.bottom > video.top) return true
  }
  return false
}
