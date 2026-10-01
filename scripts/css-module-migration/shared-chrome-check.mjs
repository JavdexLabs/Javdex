import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkSharedChrome({ page, name, width, theme, output }) {
  const dialog = page.getByRole('dialog', { name: '共享外观检查 长标题与说明' })
  await dialog.waitFor()
  const descriptionId = await dialog.getAttribute('aria-describedby')
  const metrics = await page.locator(`[id="${descriptionId}"]`).evaluate(el => {
    const css = getComputedStyle(el)
    return { fontSize: css.fontSize, lineHeight: css.lineHeight, color: css.color, margin: css.margin }
  })
  assert.equal(metrics.fontSize, '12px')
  assert.equal(await dialog.getByRole('textbox', { name: '代码编辑器' }).isDisabled(), true)
  await dialog.getByText('暂无资料', { exact: true }).waitFor()
  const refresh = dialog.getByRole('button', { name: '刷新分组', exact: true })
  await refresh.focus()
  await refresh.press('Enter')
  assert.equal(await page.evaluate(() => window.sharedChromeAction), 'refresh')
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true, caret: 'hide' })
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  assert.equal(await page.evaluate(() => window.sharedChromeAction), 'save')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await page.evaluate(() => window.sharedChromeAction), 'cancel')
  return metrics
}
