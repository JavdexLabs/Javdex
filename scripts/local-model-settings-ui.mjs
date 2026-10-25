import assert from 'node:assert/strict'

export async function waitForLocalModelSettings(page) {
  for (const name of ['语音模型-Whisper', '语音模型-ASR', '文本模型']) await page.getByRole('heading', { name, exact: true }).waitFor()
  await page.locator('[aria-label="存储与维护"]').waitFor()
}

export async function checkLocalModelCatalog(page, models) {
  assert.equal(await page.getByRole('article').count(), models.length)
  for (const [name, group] of [['语音模型-Whisper', 'speech'], ['语音模型-ASR', 'qwen-speech']]) {
    const section = page.getByRole('region', { name, exact: true })
    assert.equal(await section.locator(`[data-runtime-group="${group}"]`).count(), 1)
    assert.equal(await section.getByRole('article').locator('[data-runtime-group]').count(), 0, 'environment belongs to its module')
  }
  for (const model of models) {
    const family = page.getByRole('article', { name: `${model.name} 模型文件`, exact: true })
    const toggle = family.getByRole('button', { name: `${model.name} 精度列表`, exact: true })
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    assert.equal(await family.locator('tr[data-variant]').count(), model.variants.length)
    for (const variant of model.variants) {
      // The precision row owns its menu trigger; the actual popup is portaled.
      const target = family.locator(`tr[data-variant="${variant.id}"]`)
      await target.getByRole('button', { name: /更多操作$/ }).click()
      await page.getByRole('menuitem', { name: '精度与验证详情', exact: true }).click()
      const details = page.getByRole('dialog', { name: '精度与验证详情', exact: true })
      await details.waitFor()
      await details.getByText('来源、校验与适用范围', { exact: true }).click()
      assert.equal(await details.getByText(variant.source, { exact: true }).isVisible(), true)
      await details.locator('[data-modal-part="head"]').getByRole('button', { name: '关闭', exact: true }).click()
      await details.waitFor({ state: 'hidden' })
    }
  }
}

export async function checkLocalModelInstalledFilters(page) {
  for (const name of ['语音模型-Whisper', '语音模型-ASR', '文本模型']) {
    const filter = page.getByRole('button', { name: `${name}筛选`, exact: true })
    await filter.click()
    await page.getByRole('option', { name: '已下载', exact: true }).click()
    const group = page.getByRole('region', { name, exact: true })
    assert.equal(await group.getByRole('article').count(), 0)
    assert.equal(await group.getByText('暂无符合筛选条件的模型。', { exact: true }).isVisible(), true)
    await filter.click()
    await page.getByRole('option', { name: '全部精度', exact: true }).click()
  }
}
