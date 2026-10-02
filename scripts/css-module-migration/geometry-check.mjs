import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkStyleGeometry({ page, name, width, theme, output }) {
  const layer = page.getByRole('dialog', { name: '浮层几何检查' })
  const anchor = page.getByRole('button', { name: '打开浮层' })
  await layer.waitFor()
  await page.evaluate(async () => {
    await document.fonts.ready
    window.dispatchEvent(new Event('resize'))
  })
  const check = async () => {
    await page.waitForFunction(() => {
      const anchor = document.querySelector('main > button'), layer = document.querySelector('[aria-label="浮层几何检查"]')
      return Math.abs(layer.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom - 8) < 0.1
    })
    const metrics = await layer.evaluate(el => {
      const css = getComputedStyle(el), box = el.getBoundingClientRect()
      return { position: css.position, zIndex: css.zIndex, width: box.width, visibility: css.visibility,
        layerBase: Number(css.getPropertyValue('--layer-overlay')), layerStep: Number(css.getPropertyValue('--layer-step')),
        top: box.top, left: box.left, inlinePosition: el.style.position, inlineZIndex: el.style.zIndex,
        callerClass: el.classList.contains('fixture-caller-layer'), portal: el.parentElement === document.body }
    })
    assert.equal(metrics.position, 'fixed')
    assert.equal(Number(metrics.zIndex), metrics.layerBase + metrics.layerStep)
    assert.equal(metrics.inlinePosition, '')
    assert.ok(metrics.inlineZIndex.includes('var(--layer-overlay'), 'layer-owned depth overrides caller zIndex')
    assert.equal(metrics.width, 180)
    assert.equal(metrics.visibility, 'visible')
    assert.equal(metrics.callerClass, true)
    assert.equal(metrics.portal, true)
    const box = await anchor.boundingBox()
    assert.ok(Math.abs(metrics.top - (box.y + box.height + 8)) < 0.1, JSON.stringify({ metrics, box }))
    assert.ok(Math.abs(metrics.left - box.x) < 0.1)
    return metrics
  }
  const metrics = await check()
  const viewport = await page.locator('[data-geometry-viewport]').evaluate(el => {
    const css = getComputedStyle(el)
    return { x: css.overflowX, y: css.overflowY, gutter: css.scrollbarGutter, width: css.width, height: css.height }
  })
  assert.deepEqual(viewport, { x: 'hidden', y: 'auto', gutter: 'stable', width: '180px', height: '80px' })
  await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), caret: 'hide' })
  await layer.getByRole('button', { name: '浮层内部按钮' }).click()
  await page.getByRole('button', { name: '忽略关闭的按钮' }).click()
  await anchor.click()
  assert.equal(await layer.count(), 1)
  await page.evaluate(() => window.scrollTo(0, 60))
  assert.equal(await page.evaluate(() => window.scrollY), 60)
  await page.waitForFunction(() => {
    const anchor = document.querySelector('main > button'), layer = document.querySelector('[aria-label="浮层几何检查"]')
    return Math.abs(layer.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom - 8) < 0.1
  })
  const scrolled = await check()
  assert.ok(Math.abs(metrics.top - scrolled.top - 60) < 0.1)
  await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-scroll.png`), caret: 'hide' })
  await page.setViewportSize({ width: width - 20, height: width === 1440 ? 900 : 640 })
  await check()
  await page.locator('[data-outside]').click()
  await layer.waitFor({ state: 'detached' })
  await anchor.click()
  await layer.waitFor()
  await check()
  return { layer: metrics, viewport }
}
