import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkSettingsDensity({ page, name, width, theme, output }) {
  if (name !== 'settingsDensityStandalone') {
    assert.equal(await page.locator('[data-page-content]').evaluate(el => getComputedStyle(el).paddingBottom), '0px')
  }
  const snapshot = async suffix => {
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(180)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-${suffix}.png`), fullPage: true, caret: 'hide' })
  }
  const style = async locator => locator.evaluate(el => {
    const css = getComputedStyle(el)
    return { fontSize: css.fontSize, lineHeight: css.lineHeight, minHeight: css.minHeight, gap: css.gap }
  })
  if (name === 'settingsDensityPanels') {
    const host = page.locator('[data-density-panels]')
    await host.getByRole('heading', { name: '资源存储' }).waitFor()
    const add = host.getByRole('button', { name: '添加目录' })
    const scan = host.getByRole('button', { name: '扫描并导入' })
    const pick = host.getByRole('button', { name: '更改目录' })
    const metrics = { add: await style(add), scan: await style(scan), pick: await style(pick) }
    assert.equal(await add.evaluate(el => getComputedStyle(el).minWidth), '104px')
    assert.equal(await scan.evaluate(el => getComputedStyle(el).minWidth), '128px')
    assert.equal(metrics.pick.gap, '6px')
    await snapshot('panels')
    await pick.click()
    assert.equal(await page.evaluate(() => window.densityPanelAction), 'path')
    await scan.click()
    assert.equal(await page.evaluate(() => window.densityPanelAction), 'scan')
    await add.click()
    assert.equal(await page.evaluate(() => window.densityPanelAction), 'roots')
    return metrics
  }
  const workspace = name === 'settingsDensityWorkspace'
  const host = page.locator('[data-density-controls]')
  await host.getByText('需要处理', { exact: true }).waitFor()
  const save = host.getByRole('button', { name: '保存', exact: true })
  const counter = host.getByRole('textbox', { name: '密度计数' })
  const metrics = { status: await style(host.getByText('需要处理', { exact: true })),
    unit: await style(host.getByText('分钟', { exact: true })), save: await style(save),
    disabled: await style(host.getByRole('button', { name: '禁用按钮' })), icon: await style(host.getByRole('button', { name: '密度图标' })),
    toolbar: await style(host.getByRole('button', { name: '工具栏按钮' })),
    selection: await style(host.getByRole('button', { name: '批量按钮' })),
    detail: await style(host.getByRole('button', { name: '详情按钮' })) }
  assert.equal(metrics.save.fontSize, workspace ? '12px' : '13px')
  assert.equal(metrics.save.minHeight, workspace ? '32px' : '36px')
  assert.equal(metrics.unit.fontSize, workspace ? '11px' : '12px')
  assert.equal(metrics.status.fontSize, '11px')
  assert.equal(await host.getByRole('textbox', { name: '普通输入', exact: true }).evaluate(el => getComputedStyle(el).fontSize), '13px')
  assert.equal(await host.getByRole('textbox', { name: '工作区输入', exact: true }).evaluate(el => getComputedStyle(el).fontSize), workspace ? '12px' : '13px')
  assert.equal(await host.getByRole('button', { name: '禁用按钮' }).isDisabled(), true)
  await snapshot('idle')
  await counter.fill('24')
  await counter.press('Tab')
  assert.equal(await counter.inputValue(), '24')
  await save.focus()
  const idleBounds = await save.boundingBox()
  await page.keyboard.press('Enter')
  assert.equal(await save.isDisabled(), true)
  assert.equal(await save.getAttribute('aria-busy'), 'true')
  assert.deepEqual(await save.boundingBox(), idleBounds)
  await snapshot('busy')
  await page.evaluate(() => window.finishDensitySave('error'))
  await host.getByText('保存失败，请重试', { exact: true }).waitFor()
  assert.equal(await counter.inputValue(), '24')
  await snapshot('error')
  await save.click()
  assert.equal(await page.evaluate(() => window.densitySaveCount), 2)
  await page.evaluate(() => window.finishDensitySave('success'))
  await host.getByText('保存成功', { exact: true }).waitFor()
  await snapshot('success')
  return metrics
}
