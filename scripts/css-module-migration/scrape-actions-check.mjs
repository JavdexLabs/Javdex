import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkScrapeActions({ page, name, width, theme, output }) {
  const dialog = page.getByRole('dialog', { name: '批量刮削配置' })
  await dialog.waitFor()
  const config = dialog.getByRole('complementary', { name: '任务配置' })
  const fields = dialog.getByRole('region', { name: '写入字段' })
  const confirm = dialog.getByRole('button', { name: '开始修正' })
  const activate = async button => {
    await button.click({ timeout: 5000 })
  }
  const snapshot = async suffix => {
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise(requestAnimationFrame)
      await Promise.all(document.getAnimations().filter(animation =>
        animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
      await new Promise(requestAnimationFrame)
    })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), fullPage: true, caret: 'hide' })
  }
  const selectNone = fields.getByRole('button', { name: '全不选', exact: true })
  const metrics = await selectNone.evaluate(el => {
    const css = getComputedStyle(el)
    return { minHeight: css.minHeight, fontSize: css.fontSize, padding: css.padding,
      borderLeft: css.borderLeftWidth, lineHeight: css.lineHeight }
  })
  assert.deepEqual(metrics, { minHeight: '24px', fontSize: '11px', padding: '0px 8px', borderLeft: '1px', lineHeight: '11px' })
  assert.ok(await config.isVisible())
  assert.ok(await dialog.getByRole('radiogroup', { name: '影片范围' }).isVisible())
  await snapshot('')
  await activate(selectNone)
  assert.equal(await fields.getByRole('checkbox', { checked: true }).count(), 0)
  assert.equal(await confirm.isDisabled(), true)
  await snapshot('-write-empty')
  const basic = fields.locator('section').filter({ has: page.getByText('基本信息', { exact: true }) })
  const selectBasic = basic.getByRole('button', { name: '全选', exact: true })
  await selectBasic.focus()
  await selectBasic.press('Enter')
  assert.equal(await fields.getByRole('checkbox', { name: '标题', exact: true }).isChecked(), true)
  assert.equal(await fields.getByRole('checkbox', { checked: true }).count(), 1)
  await activate(basic.getByRole('button', { name: '清空', exact: true }))
  assert.equal(await fields.getByRole('checkbox', { checked: true }).count(), 0)
  await activate(selectBasic)
  await activate(config.getByRole('button', { name: '不限', exact: true }))
  assert.equal(await config.getByRole('checkbox', { name: '标题', exact: true }).count(), 0)
  await activate(config.getByRole('button', { name: '缺任一字段', exact: true }))
  assert.equal(await config.getByRole('button', { name: '缺任一字段', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await config.getByRole('button', { name: '不限', exact: true }).getAttribute('aria-pressed'), 'false')
  assert.equal(await config.getByRole('button', { name: '缺任一字段', exact: true }).evaluate(el => getComputedStyle(el).fontWeight), '700')
  assert.ok(await config.getByText('请选择至少一个缺失字段').isVisible())
  assert.equal(await confirm.isDisabled(), true)
  await snapshot('-missing')
  await activate(config.getByRole('button', { name: '按写入字段', exact: true }))
  assert.equal(await config.getByRole('checkbox', { name: '标题', exact: true }).isChecked(), true)
  assert.equal(await confirm.isDisabled(), false)
  await snapshot('-matching')
  await activate(config.getByRole('button', { name: '全选', exact: true }))
  assert.equal(await config.getByRole('checkbox', { checked: true }).count(), 3)
  await activate(config.getByRole('button', { name: '清空', exact: true }))
  assert.equal(await confirm.isDisabled(), true)
  await activate(config.getByRole('button', { name: '不限', exact: true }))
  await activate(confirm)
  const args = await page.evaluate(() => window.lastScrapeFieldsConfirm)
  assert.deepEqual(args.slice(0, 5), [['title'], 'JavDB', 'all', 'fillEmpty', []])
  return metrics
}
