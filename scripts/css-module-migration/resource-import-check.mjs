import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkResourceImport({ page, name, width, theme, output }) {
  const library = ['resourceImportLibrary', 'resourceImportRemote'].includes(name)
  const edit = ['resourceImportEdit', 'resourceImportStrm'].includes(name)
  const remote = name === 'resourceImportRemote'
  const strm = name === 'resourceImportStrm'
  const dialog = page.getByRole('dialog', { name: new RegExp(`^${edit ? '编辑影片资源' : library ? '添加影片' : '导入影片资源'}`) })
  const snapshot = async suffix => {
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), caret: 'hide' })
  }
  await dialog.waitFor()
  await snapshot('')
  let url, size, probe
  if (library) {
    await dialog.getByLabel('影片番号', { exact: true }).fill('ABC-123')
    const candidates = dialog.getByRole('listbox', { name: '归入影片' })
    await candidates.getByRole('option').nth(1).waitFor()
    await candidates.getByRole('option').nth(1).click()
    assert.equal(await dialog.getByRole('button', { name: '添加到所选影片', exact: true }).isDisabled(), true)
    await dialog.locator('section').filter({ has: page.getByText('资源链接', { exact: true }) })
      .getByRole('button', { name: '添加链接', exact: true }).click()
    url = dialog.getByRole('textbox', { name: '资源 1 链接', exact: true })
    size = dialog.getByRole('spinbutton', { name: '资源 1 文件大小', exact: true })
    probe = dialog.getByRole('button', { name: '尝试读取资源 1 的文件大小，不验证能否播放', exact: true })
    await url.fill('https://cdn.example/ABC-123.mp4')
  } else {
    url = dialog.getByLabel('资源链接', { exact: true })
    size = dialog.getByRole('spinbutton', { name: '文件大小', exact: true })
    probe = dialog.getByRole('button', { name: '尝试读取直链文件大小，不验证能否播放', exact: true })
    assert.equal(await url.isDisabled(), strm)
    if (!strm) await url.fill('https://cdn.example/ABC-123.mp4')
    await dialog.getByLabel('展示名称', { exact: true }).fill('测试资源长名称')
  }
  await url.scrollIntoViewIfNeeded()
  await snapshot('-draft')
  if (remote) {
    assert.equal(await probe.count(), 0)
    await size.fill('2')
  } else {
    await probe.click()
    await page.waitForFunction(() => typeof window.resolveResourceProbe === 'function')
    assert.equal(await probe.isDisabled(), true)
    await snapshot('-checking')
    await page.evaluate(() => window.resolveResourceProbe({ ok: true, status: 200, sizeBytes: 2147483648 }))
    await dialog.getByText('直链有响应 · HTTP 200 · 已填入文件大小', { exact: true }).waitFor()
    assert.equal(await size.inputValue(), '2')
    await snapshot('-checked')
    await probe.click()
    await page.evaluate(() => window.resolveResourceProbe({ ok: false, error: '大小读取失败：测试长路径 /fixture/影片资源/连接暂时不可用；仍可手动保存。' }))
    await dialog.getByText(/大小读取失败：测试长路径/).waitFor()
    await snapshot('-check-error')
    await size.fill('2')
  }
  const submit = dialog.getByRole('button', { name: edit ? '保存' : library ? '添加到所选影片' : '导入', exact: true })
  await submit.click()
  await page.waitForFunction(() => typeof window.rejectResourceSubmit === 'function')
  assert.equal(await submit.isDisabled(), true)
  await snapshot('-saving')
  await page.evaluate(() => window.rejectResourceSubmit(new Error('保存失败：测试长路径 /fixture/资料库/影片资源/暂时不可用，请重试。')))
  await dialog.getByText('保存失败：测试长路径 /fixture/资料库/影片资源/暂时不可用，请重试。', { exact: true }).waitFor()
  await snapshot('-save-error')
  await submit.click()
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]').textContent.includes('保存失败：测试长路径'))
  await page.evaluate(() => window.resolveResourceSubmit({ id: 11, videoId: 1, resourceId: 11 }))
  await page.waitForFunction(() => Boolean(window.completedResourceImport))
  const input = await page.evaluate(() => window.lastResourceSubmit)
  assert.equal(input.libraryId, 3)
  if (edit) { assert.equal(input.videoId, 1); assert.equal(input.sizeBytes, 2147483648) }
  else { assert.deepEqual(input.target, { kind: 'existing', videoId: 1 }); assert.equal(library ? input.resources[0].sizeBytes : input.sizeBytes, 2147483648) }
  await snapshot('-saved')
}
