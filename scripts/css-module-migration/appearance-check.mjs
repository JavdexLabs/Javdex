import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkAppearance({ page, name, width, theme, output }) {
  const host = page.locator('[data-appearance-host]')
  const preview = host.locator('[data-avatar-composition-preview]')
  const frame = host.locator('[data-avatar-composition-frame]')
  const batch = host.locator('[data-avatar-batch-row]')
  const image = frame.locator('img')
  const snapshot = async suffix => {
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), caret: 'hide' })
  }
  await host.getByRole('radiogroup', { name: '界面主题' }).waitFor()
  const palettes = [
    { background: 'rgb(32, 35, 41)', accent: 'rgb(90, 143, 200)', label: 'rgb(127, 176, 220)' },
    { background: 'rgb(36, 33, 30)', accent: 'rgb(169, 150, 106)', label: 'rgb(196, 177, 124)' },
    { background: 'rgb(30, 37, 45)', accent: 'rgb(99, 167, 173)', label: 'rgb(132, 193, 198)' },
    { background: 'rgb(247, 248, 250)', accent: 'rgb(63, 111, 181)', label: 'rgb(63, 111, 181)' }
  ]
  for (let index = 0; index < palettes.length; index++) {
    const radio = host.getByRole('radio').nth(index)
    assert.equal(await radio.evaluate(el => getComputedStyle(el).backgroundColor), palettes[index].background)
    assert.equal(await radio.locator('span').nth(1).evaluate(el => getComputedStyle(el).color), palettes[index].label)
  }
  if (name === 'appearanceError') await preview.getByText('预览不可用', { exact: true }).waitFor()
  else if (name === 'appearancePending') await preview.getByText('检测中…', { exact: true }).waitFor()
  await image.evaluate(async el => {
    if (!el.complete) await new Promise(resolve => el.addEventListener('load', resolve, { once: true }))
    if (!el.naturalWidth) throw Error('Composition sample did not load')
  })
  assert.equal(await frame.evaluate(el => getComputedStyle(el).width), '128px')
  assert.equal(await preview.getAttribute('aria-busy'), name === 'appearancePending' ? 'true' : 'false')
  await snapshot('')
  if (name !== 'appearanceReady') {
    await preview.scrollIntoViewIfNeeded()
    await snapshot('-preview')
    return
  }
  const radios = host.getByRole('radio')
  await radios.first().focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => window.lastAppearanceTheme), 'warm')
  assert.equal(await radios.nth(1).getAttribute('aria-checked'), 'true')
  await page.waitForFunction(color =>
    getComputedStyle(document.querySelector('[role="radio"][aria-checked="true"]')).borderTopColor === color,
  palettes[1].accent)
  assert.equal(await radios.nth(1).evaluate(el => getComputedStyle(el).borderTopColor), palettes[1].accent)
  await snapshot('-theme')
  const ratio = host.getByRole('slider', { name: '智能头像构图范围' })
  await ratio.focus()
  await page.keyboard.press('ArrowRight')
  await host.getByRole('button', { name: '脸部', exact: true }).click()
  await host.getByRole('switch', { name: '保留完整头部' }).click()
  assert.equal(await host.getByRole('button', { name: '构图全部头像', exact: true }).isDisabled(), true)
  await preview.scrollIntoViewIfNeeded()
  await snapshot('-draft')
  await host.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.lastAppearancePatch.avatarFaceRatio === 0.63)
  assert.equal(await page.evaluate(() => window.lastAppearancePatch.avatarCenteringMode), 'face')
  const privacy = host.getByRole('switch', { name: '防窥模式', exact: true })
  await privacy.click()
  await host.getByRole('switch', { name: '封面', exact: true }).waitFor()
  await host.getByRole('switch', { name: '封面', exact: true }).click()
  assert.equal(await page.evaluate(() => window.lastAppearancePatch.privacyModeScopes.includes('covers')), false)
  const disclosure = host.getByRole('button', { name: /保护范围/ })
  const scopes = host.locator('[id="privacy-mode-scope-list"]')
  assert.equal(await scopes.getByRole('switch').count(), 7)
  assert.equal(await scopes.evaluate(el => {
    const bounds = el.getBoundingClientRect()
    const card = el.parentElement.parentElement.getBoundingClientRect()
    return bounds.height > 200 && bounds.top >= card.top && bounds.bottom <= card.bottom
  }), true, 'Expanded privacy scopes must not be clipped by their card')
  await scopes.scrollIntoViewIfNeeded()
  await snapshot('-privacy')
  await disclosure.click()
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
  assert.equal(await scopes.count(), 0)
  await snapshot('-privacy-collapsed')
  await disclosure.click()
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true')
  await scopes.getByRole('switch', { name: '图片编辑', exact: true }).scrollIntoViewIfNeeded()
  await snapshot('-privacy-end')
  await batch.scrollIntoViewIfNeeded()
  await host.getByRole('button', { name: '构图全部头像', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '批量智能构图', exact: true })
  await confirm.waitFor()
  await snapshot('-confirm')
  await confirm.getByRole('button', { name: '开始构图', exact: true }).click()
  await batch.getByText('正在处理 测试演员长名称', { exact: true }).waitFor()
  await batch.scrollIntoViewIfNeeded()
  await snapshot('-running')
  await batch.getByRole('button', { name: '查看日志', exact: true }).click()
  assert.equal(await page.evaluate(() => window.openedAppearanceLogs), true)
  await batch.getByRole('button', { name: '停止', exact: true }).click()
  await batch.getByRole('button', { name: '正在停止…', exact: true }).waitFor()
  assert.equal(await batch.getByRole('button', { name: '正在停止…', exact: true }).isDisabled(), true)
  await snapshot('-cancelling')
  await page.evaluate(() => window.finishAppearanceBatch())
  await batch.getByText('已停止：成功 18，失败 2，跳过 0', { exact: true }).waitFor()
  await snapshot('-done')
}
