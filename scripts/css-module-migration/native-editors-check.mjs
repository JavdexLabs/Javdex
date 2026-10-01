import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkNativeEditor({ page, name, width, theme, output }) {
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const field = dialog.locator(name === 'nativeEditorVideo' ? '#video-edit-title'
    : name === 'nativeEditorPlaylist' ? '#playlist-name'
      : name === 'nativeEditorActress' ? '#actress-main-name'
        : name.startsWith('nativeEditorDirector') ? '#director-main-name'
          : name === 'nativeEditorSeries' ? '#series-main-name' : '#organization-main-name')
  const summary = dialog.locator('textarea')
  const save = dialog.getByRole('button', { name: name === 'nativeEditorPlaylist' ? '创建' : '保存', exact: true })
  const snapshot = async suffix => {
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-${suffix}.png`), caret: 'hide' })
  }
  await snapshot('empty')
  await field.fill('待保存的名称')
  assert.equal(await field.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
  assert.equal(await field.evaluate(el => getComputedStyle(el).fontSize), name.endsWith('Workspace') ? '12px' : '13px')
  await summary.fill('简介草稿')
  assert.equal(await summary.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
  assert.notEqual(await summary.evaluate(el => getComputedStyle(el).boxShadow), 'none')
  await summary.scrollIntoViewIfNeeded()
  const shortWidth = await summary.evaluate(el => el.clientWidth)
  await snapshot('draft')
  await summary.fill(Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：这是多行简介与长文本滚动检查。`).join('\n'))
  assert.equal(await summary.evaluate(el => getComputedStyle(el).scrollbarGutter), 'stable')
  assert.equal(await summary.evaluate(el => el.scrollHeight > el.clientHeight), true)
  assert.equal(await summary.evaluate(el => el.clientWidth), shortWidth)
  await snapshot('long')
  await summary.fill('简介草稿\n保留第二行')
  if (name === 'nativeEditorVideo') {
    const selected = dialog.getByRole('button', { name: '将 来源甲 设为默认外部评分', exact: true })
    assert.equal(await selected.getAttribute('aria-pressed'), 'true')
    await dialog.getByRole('button', { name: '将 来源乙 设为默认外部评分', exact: true }).click()
    await dialog.getByRole('button', { name: '删除 来源甲 评分', exact: true }).click()
    await dialog.getByRole('button', { name: '撤销删除 来源甲 评分', exact: true }).click()
    await snapshot('ratings')
  }
  await save.click()
  await page.waitForFunction(() => typeof window.rejectNativeEditor === 'function')
  assert.equal(await save.isDisabled(), true)
  assert.equal(await dialog.getAttribute('aria-busy'), 'true')
  assert.equal(await page.evaluate(() => window.nativeEditorSaveCount), 1)
  if (name === 'nativeEditorVideo') {
    assert.deepEqual(await page.evaluate(() => window.nativeEditorInput.externalRatings), { deletedSources: [], defaultSource: '来源乙' })
    assert.equal(await dialog.getByRole('button', { name: '将 来源乙 设为默认外部评分', exact: true }).isDisabled(), true)
  }
  await snapshot('busy')
  await page.evaluate(() => window.rejectNativeEditor(new Error('保存失败：/fixture/很长的资料路径/暂时不可用，请重试。')))
  const error = dialog.getByText('保存失败：/fixture/很长的资料路径/暂时不可用，请重试。', { exact: true })
  await error.waitFor({ state: 'attached' })
  assert.equal(await error.isVisible(), false)
  await snapshot('error')
  const details = dialog.getByText('操作未完成，可重试或查看错误详情', { exact: true })
  await details.focus()
  await page.keyboard.press('Enter')
  await error.waitFor()
  await snapshot('error-details')
  assert.equal(await field.inputValue(), '待保存的名称')
  assert.equal(await summary.inputValue(), '简介草稿\n保留第二行')
  await save.click()
  await page.waitForFunction(() => window.nativeEditorSaveCount === 2)
  await snapshot('retry')
  await page.evaluate(() => window.resolveNativeEditor())
  await dialog.waitFor({ state: 'hidden' })
  await page.getByText('已保存', { exact: true }).waitFor()
}
