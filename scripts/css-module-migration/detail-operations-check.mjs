import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkDetailOperations({ page, name, width, theme, output }) {
  const last = name !== 'videoDetailOperations'
  const strm = name === 'videoDetailLastStrm'
  const snapshot = async suffix => {
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-${suffix}.png`), caret: 'hide' })
  }
  const toolbarMenu = async label => {
    await page.getByRole('toolbar', { name: '影片操作', exact: true }).getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  const resourceMenu = async (index, label) => {
    await page.locator('[data-resource-row]').nth(index).getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  const rejectCommand = async () => {
    await page.waitForFunction(() => typeof window.rejectDetailCommand === 'function')
    await page.evaluate(() => window.rejectDetailCommand(new Error('操作失败：测试长路径 /fixture/影片资源/暂时不可用，请重试。')))
    const error = page.getByText('操作失败：测试长路径 /fixture/影片资源/暂时不可用，请重试。', { exact: true })
    await error.waitFor({ state: 'attached' })
    if (!(await error.isVisible())) {
      await page.getByText('操作未完成，可重试或查看错误详情', { exact: true }).click()
    }
    await error.waitFor()
  }
  await page.getByRole('heading', { name: /影片详情操作验收/ }).waitFor()
  assert.equal(await page.locator('[data-resource-row]').count(), last ? 1 : 3)
  await snapshot('page')
  if (!last) {
    await toolbarMenu('修正番号')
    let dialog = page.getByRole('dialog', { name: '修正导入', exact: true })
    const code = dialog.getByRole('textbox', { name: '番号', exact: true })
    await code.fill('NEW-456')
    assert.equal(await code.evaluate(el => el === document.activeElement), true)
    await snapshot('correct-draft')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => window.lastDetailCommand?.name === 'correct')
    assert.deepEqual(await page.evaluate(() => window.lastDetailCommand.input), [1, 'NEW-456', false])
    await snapshot('correct-busy')
    await rejectCommand()
    await snapshot('correct-error')
    assert.equal(await code.inputValue(), 'NEW-456')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '关闭', exact: true }).click()

    await toolbarMenu('合并同番号影片')
    dialog = page.getByRole('dialog', { name: /^合并同番号影片/ })
    const merge = dialog.getByRole('button', { name: '合并', exact: true })
    assert.equal(await merge.isDisabled(), true)
    await snapshot('merge-empty')
    await dialog.locator('button[aria-haspopup="listbox"]').click()
    await page.getByRole('option', { name: /ID 2/ }).click()
    await dialog.getByRole('radio', { name: '保留当前影片 ID 1', exact: true }).check()
    assert.equal(await merge.isDisabled(), false)
    await snapshot('merge-selected')
    await merge.click()
    await page.waitForFunction(() => window.lastDetailCommand?.name === 'merge')
    assert.deepEqual(await page.evaluate(() => window.lastDetailCommand.input), { retainedVideoId: 1, sourceVideoId: 2 })
    await snapshot('merge-busy')
    await rejectCommand()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '关闭', exact: true }).click()

    await resourceMenu(0, '编辑标签')
    dialog = page.getByRole('dialog', { name: /^编辑本地资源/ })
    const label = dialog.getByRole('textbox')
    await label.fill('新的本地资源标签')
    await snapshot('label-draft')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => window.lastDetailCommand?.name === 'label')
    assert.deepEqual(await page.evaluate(() => window.lastDetailCommand.input), [3, 1, 11, '新的本地资源标签'])
    await snapshot('label-busy')
    await rejectCommand()
    assert.equal(await label.inputValue(), '新的本地资源标签')
    await snapshot('label-error')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.evaluate(() => window.resolveDetailCommand(true))
    await dialog.waitFor({ state: 'hidden' })

    await resourceMenu(1, '拆分为独立影片')
    dialog = page.getByRole('dialog', { name: '拆分影片资源', exact: true })
    await snapshot('split')
    await dialog.getByRole('button', { name: '拆分', exact: true }).click()
    await page.waitForFunction(() => window.lastDetailCommand?.name === 'split')
    assert.deepEqual(await page.evaluate(() => window.lastDetailCommand.input), [3, 1, 12])
    await snapshot('split-busy')
    await rejectCommand()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
  }
  await resourceMenu(last ? 0 : 2, last ? strm ? '删除 STRM 源文件' : '删除本地文件' : '移除链接资源')
  const dialog = page.getByRole('dialog', { name: last ? strm ? '删除 STRM 源文件' : '删除本地文件' : '移除链接资源', exact: true })
  if (last) {
    await dialog.getByText(/选择“永久删除影片”还会在确认后删除待确认刮削候选/).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '保留影片元数据', exact: true }).isEnabled(), true)
  }
  await snapshot('remove')
  await dialog.getByRole('button', { name: last ? '保留影片元数据' : '移除资源', exact: true }).click()
  await page.waitForFunction(() => window.lastDetailCommand?.name === 'remove')
  const input = await page.evaluate(() => window.lastDetailCommand.input)
  assert.deepEqual(input.slice(0, 3), [3, 1, last ? 11 : 13])
  assert.equal(input[3], last ? 'retain-video' : undefined)
  await snapshot('remove-busy')
  await rejectCommand()
  await snapshot('remove-error')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
}
