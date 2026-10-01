import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkAppShell({ page, name, width, theme, output }) {
  const nav = page.locator('aside nav')
  const library = nav.getByRole('link', { name: '当前媒体库：用于检查长名称截断' })
  const badge = nav.getByRole('button', { name: '打开 9 项待确认' })
  await library.waitFor()
  await badge.waitFor()
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
  await page.waitForFunction(theme => {
    const expected = theme === 'light' ? 'rgb(28, 35, 43)' : 'rgb(240, 242, 245)'
    return getComputedStyle(document.body).color === expected &&
      getComputedStyle(document.querySelector('[data-fixture-content]')).color === expected
  }, theme)
  const root = page.locator('#root > div').first()
  const background = root.locator(':scope > div[aria-hidden]')
  const route = page.locator('[data-fixture-route]')
  const snapshot = async suffix => {
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), caret: 'hide' })
  }
  const metrics = await page.locator('aside').evaluate(el => {
    const brand = el.querySelector('[aria-label="Javdex"] > span')
    const home = el.querySelector('nav a')
    const currentLibrary = el.querySelector('[aria-label="媒体库列表"] a')
    const pending = el.querySelector('a[href="/pending"]')
    const css = node => getComputedStyle(node)
    return { sidebar: el.getBoundingClientRect().width, brand: css(brand).fontSize,
      homeGap: css(home).gap, homePadding: css(home).padding, libraryPadding: css(currentLibrary).padding,
      libraryHeight: css(currentLibrary).height, pendingPadding: css(pending).padding,
      bottom: el.querySelector('a[href="/settings"]')?.getBoundingClientRect().bottom }
  })
  assert.equal(metrics.sidebar, width > 1120 ? 210 : 176)
  assert.equal(metrics.brand, width > 1120 ? '26px' : '22px')
  assert.ok(metrics.bottom <= page.viewportSize().height, 'sidebar maintenance stays within the viewport')
  assert.equal(metrics.libraryPadding, '0px 8px')
  assert.equal(metrics.pendingPadding, width > 1120 ? '0px 44px 0px 14px' : '0px 44px 0px 10px')
  assert.equal(await nav.getByRole('link', { name: '已归档' }).count(), 0)
  await snapshot('')
  await library.focus()
  await library.press('Enter')
  await route.getByText('/libraries/3?q=ABC', { exact: true }).waitFor()
  assert.equal(await route.innerText(), '/libraries/3?q=ABC')
  await badge.click()
  await route.getByText('/pending', { exact: true }).waitFor()
  assert.equal(await route.innerText(), '/pending')
  await nav.getByRole('link', { name: '导演', exact: true }).click()
  await route.getByText('/facet/director', { exact: true }).waitFor()
  assert.equal(await route.innerText(), '/facet/director')
  await snapshot('-facet')
  await page.evaluate(() => window.fixtureShell.navigate('/libraries/3/video/1?q=ABC'))
  await route.getByText('/libraries/3/video/1?q=ABC', { exact: true }).waitFor()
  for (const [kind, dimensions] of [['landscape', [800, 400]], ['portrait', [400, 800]]]) {
    await page.route(`**/shell-${kind}.svg`, async request => request.fulfill({ contentType: 'image/svg+xml', body:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions[0]}" height="${dimensions[1]}"><rect width="100%" height="100%" fill="#4b6372"/><circle cx="200" cy="200" r="120" fill="#bc977d"/></svg>` }))
    await page.evaluate(kind => window.fixtureShell.background.setBackground('video:1', { path: `${location.origin}/shell-${kind}.svg` }), kind)
    await background.locator('img').waitFor()
    await background.locator('img').evaluate(async img => {
      if (!img.complete) await new Promise(resolve => img.addEventListener('load', resolve, { once: true }))
      if (!img.naturalWidth) throw new Error('Background fixture did not load')
    })
    if (kind === 'portrait') await page.waitForFunction(() => {
      const img = document.querySelector('#root > div > div[aria-hidden] img')
      return img && getComputedStyle(img).objectPosition === '50% 0%'
    })
    await snapshot(`-${kind}`)
    assert.equal(await background.evaluate(el => getComputedStyle(el).pointerEvents), 'none')
    const expectedFrameWidth = Math.min(width, (width === 1440 ? 900 : 640) / 2)
    if (kind === 'portrait') assert.ok(Math.abs((await background.locator('img').boundingBox()).width - expectedFrameWidth) < 0.1)
  }
  await page.evaluate(() => window.fixtureShell.privacy(true))
  await background.waitFor({ state: 'detached' })
  await snapshot('-privacy')
  await page.evaluate(() => window.fixtureShell.privacy(false))
  await background.waitFor()
  await page.evaluate(() => { window.closeFixturePreview = window.fixtureShell.preview.register() })
  await background.waitFor({ state: 'detached' })
  await page.evaluate(() => window.closeFixturePreview())
  await background.waitFor()
  await page.evaluate(() => window.fixtureShell.background.clearBackground('video:1'))
  await background.waitFor({ state: 'detached' })
  await nav.getByRole('button', { name: '新建媒体库' }).click()
  const dialog = page.getByRole('dialog', { name: '新建媒体库' })
  await dialog.waitFor()
  assert.equal(await dialog.evaluate(el => el.closest('aside') == null), true)
  await snapshot('-create')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.evaluate(() => window.fixtureShell.state('empty'))
  await nav.getByText('暂无媒体库', { exact: true }).waitFor()
  await nav.getByRole('button', { name: '打开 6 项待确认' }).waitFor()
  await snapshot('-empty')
  await page.evaluate(() => window.fixtureShell.state('error'))
  await nav.getByRole('button', { name: '读取失败，重试' }).waitFor()
  await nav.getByRole('button', { name: '待确认数量加载失败，打开待确认项' }).waitFor()
  await snapshot('-error')
  await page.evaluate(() => { void window.fixtureShell.state('loading') })
  await nav.getByText('正在读取…', { exact: true }).waitFor()
  await nav.getByRole('button', { name: '待确认数量加载中，打开待确认项' }).waitFor()
  await snapshot('-loading')
  return metrics
}
