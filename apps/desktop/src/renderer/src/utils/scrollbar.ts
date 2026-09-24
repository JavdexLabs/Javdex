/** Measure the OS scrollbar width once (typically 15–17px on Windows). */
let cached: number | null = null

export function scrollbarWidth(): number {
  if (cached !== null) return cached
  if (typeof document === 'undefined') return 17

  const outer = document.createElement('div')
  outer.style.cssText = 'visibility:hidden;overflow:scroll;width:100px;height:100px;position:absolute;top:-9999px'
  document.body.appendChild(outer)
  const inner = document.createElement('div')
  inner.style.width = '100%'
  outer.appendChild(inner)
  cached = outer.offsetWidth - inner.offsetWidth || 17
  outer.remove()
  return cached
}
