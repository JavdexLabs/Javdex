import assert from 'node:assert/strict'

// Shared interactions for the real playback settings used by local/remote
// development smoke scripts. These helpers never command the playback API.
export async function openPlaybackSettings(page, tab = '播放') {
  assert.ok(['播放', '字幕', '信息'].includes(tab), `Unknown playback settings tab: ${tab}`)
  const settings = page.getByRole('complementary', { name: '播放设置', exact: true })
  if (!await settings.isVisible()) await page.getByRole('button', { name: '播放设置', exact: true }).click()
  await settings.getByRole('tab', { name: tab, exact: true }).click()
  await settings.getByRole('tabpanel', { name: tab, exact: true }).waitFor({ state: 'visible' })
  return settings
}

export async function closePlaybackSettings(page) {
  const settings = page.getByRole('complementary', { name: '播放设置', exact: true })
  if (await settings.isVisible()) {
    await settings.getByRole('button', { name: '关闭播放设置', exact: true }).click()
    await settings.waitFor({ state: 'hidden' })
  }
}

async function openSetting(page, label) {
  const tab = { 音轨: '播放', 倍速: '播放', 章节: '播放', 字幕: '字幕', 字幕字号: '字幕' }[label]
  assert.ok(tab, `Unknown playback setting: ${label}`)
  const settings = await openPlaybackSettings(page, tab)
  await settings.getByRole('button', { name: label, exact: true }).click()
  const menu = page.getByRole('listbox')
  await menu.waitFor({ state: 'visible' })
  return menu
}

export async function playbackSettingLabels(page, label) {
  const menu = await openSetting(page, label)
  const labels = await menu.getByRole('option').allTextContents()
  assert.ok(labels.length > 0, `Missing ${label} options`)
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  return labels
}

export async function selectPlaybackSetting(page, label, option) {
  assert.ok(typeof option === 'string' || option instanceof RegExp, 'Expected an exact option label or RegExp')
  const menu = await openSetting(page, label)
  // SelectControl renders its options in a portal, outside the settings aside.
  // Click that actual menu; do not infer behavior from its JSX <option> inputs.
  const choice = menu.getByRole('option', { name: option, exact: typeof option === 'string' })
  assert.equal(await choice.count(), 1, `Expected one ${label} option matching ${option}`)
  await choice.click()
  await menu.waitFor({ state: 'hidden' })
}
