// Fixture-only waiting: do not inject styles, disable transitions or wait for
// deliberately pending business requests. Preserve every screenshot option.
export function installStableScreenshots(page) {
  const screenshot = page.screenshot.bind(page)
  page.screenshot = async options => {
    await page.evaluate(async () => {
      async function bounded(promise, describe) {
        let timer
        try {
          await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Screenshot stability timeout: ${describe()}`)), 5000)
          })])
        } finally { clearTimeout(timer) }
      }
      await bounded(document.fonts.ready, () => 'fonts')
      const candidates = [...document.images].filter(image => {
        const box = image.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 &&
          box.top < innerHeight && box.left < innerWidth &&
          !image.closest('[hidden], [inert]') && getComputedStyle(image).visibility !== 'hidden'
      })
      // Viewport coordinates alone do not account for a horizontally clipped
      // gallery. Native lazy loading may never start for those off-strip images.
      const visibleImages = []
      if (candidates.length) await bounded(new Promise(resolve => {
        const pending = new Set(candidates)
        const observer = new IntersectionObserver(entries => {
          for (const entry of entries) {
            if (!pending.has(entry.target)) continue
            if (entry.intersectionRatio > 0) visibleImages.push(entry.target)
            pending.delete(entry.target)
          }
          if (!pending.size) { observer.disconnect(); resolve() }
        })
        candidates.forEach(image => observer.observe(image))
      }), () => 'image intersections')
      await bounded(Promise.all(visibleImages.map(async image => {
        if (!image.complete) await new Promise(resolve => {
          image.addEventListener('load', resolve, { once: true })
          image.addEventListener('error', resolve, { once: true })
        })
        await image.decode().catch(() => {})
      })), () => `images ${JSON.stringify(visibleImages.filter(image => !image.complete)
        .map(image => ({ src: image.getAttribute('src'), loading: image.loading })))}`)
      await new Promise(requestAnimationFrame)
      await bounded(Promise.all(document.getAnimations()
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {}))), () => 'finite animations')
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    return screenshot(options)
  }
}
