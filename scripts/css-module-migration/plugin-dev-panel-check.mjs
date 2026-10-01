import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkPluginDevPanel({ page, name, width, theme, output }) {
  const settings = name === 'pluginDevPanelSettings'
  const host = page.locator('[data-actual-plugin-panel-host]')
  const shell = host.locator('[data-workbench-part="shell"]')
  const main = host.locator('[data-workbench-part="main"]')
  const develop = host.getByRole('button', { name: 'AI开发', exact: true })
  await host.getByText('Synthetic Tool Model', { exact: true }).waitFor()
  await host.getByText('下一步请先填写网站主页。', { exact: true }).waitFor()
  assert.equal(await develop.isDisabled(), true)
  const metrics = await shell.evaluate(el => {
    const css = getComputedStyle(el)
    const main = el.querySelector('[data-workbench-part="main"]')
    const link = el.querySelector('nav button')
    return { border: css.borderTopWidth, padding: css.padding, gap: css.gap,
      columns: getComputedStyle(main).gridTemplateColumns,
      linkFont: getComputedStyle(link).fontSize, linkLine: getComputedStyle(link).lineHeight,
      width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }
  })
  assert.equal(metrics.border, settings ? '0px' : '1px')
  assert.equal(metrics.padding, settings ? '0px' : '10px')
  assert.equal(metrics.linkFont, settings ? '11px' : '12px')
  const snapshot = async suffix => {
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime))
        .map(a => a.finished.catch(() => {})))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), caret: 'hide' })
  }
  assert.equal(await main.evaluate(el => getComputedStyle(el).display), 'grid')
  await snapshot('')
  await host.getByPlaceholder('https://example.com').fill('https://example.test')
  await page.waitForFunction(() => !document.querySelector('[data-plugin-dev-attention]'))
  assert.equal(await develop.isEnabled(), true)
  await snapshot('-configured')
  await host.getByRole('group', { name: '插件类型', exact: true }).getByRole('button', { name: '演员', exact: true }).click()
  await host.getByPlaceholder('https://example.com').fill('https://actress.example.test')
  assert.equal(await develop.isEnabled(), true)
  await snapshot('-actress')
  await host.getByRole('button', { name: '连接设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent 连接配置', exact: true })
  await dialog.waitFor()
  assert.equal(await dialog.evaluate(el => getComputedStyle(el.parentElement).position), 'fixed')
  await snapshot('-connection')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await host.getByRole('navigation', { name: '当前位置' }).getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('[data-fixture-route]').getByText('/settings/overview/status', { exact: true }).waitFor()
  return metrics
}
