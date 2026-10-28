import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { openPlaybackSettings, closePlaybackSettings, selectPlaybackSetting, playbackSettingLabels } from './playback-settings-ui.mjs'

// Actual production PlaybackPanel; synthetic RPC only. No native media or
// software packages are read/downloaded by this development regression.
const repo = process.cwd()
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-settings-'))
let server, browser
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/ui-regression'),
    cacheDir: path.join(temporary, '.vite'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 5179, watch: null, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ ...(process.env.JAVDEX_BROWSER_EXECUTABLE
    ? { executablePath: process.env.JAVDEX_BROWSER_EXECUTABLE } : { channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome' }), headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }]) {
    for (const fullscreen of [false, true]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    page.setDefaultTimeout(3000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/playback-settings.html${fullscreen ? '?fullscreen=1' : ''}`)
    const revealControls = async () => {
      if (fullscreen) await page.mouse.move(viewport.width / 2, viewport.height - 5)
    }
    if (fullscreen) {
      await page.getByRole('dialog', { name: '内置播放器', exact: true }).waitFor()
      await revealControls()
    }
    await page.getByRole('button', { name: '播放设置', exact: true }).waitFor()
    assert.deepEqual(errors, [], 'the actual production player must have initialized')
    await openPlaybackSettings(page)
    const audioLabels = await playbackSettingLabels(page, '音轨')
    assert.match(audioLabels.find(label => label.startsWith('Main')), /eng.*2 声道/)
    assert.match(audioLabels.find(label => label.startsWith('Dub')), /jpn.*6 声道/)
    await selectPlaybackSetting(page, '音轨', /^Dub/)
    await selectPlaybackSetting(page, '音轨', '关闭音轨')
    await selectPlaybackSetting(page, '音轨', /^Main/)
    await selectPlaybackSetting(page, '倍速', '1.5×')
    await selectPlaybackSetting(page, '章节', 'Ending')
    await selectPlaybackSetting(page, '字幕', /^Plain/)
    await selectPlaybackSetting(page, '字幕字号', '40')
    await selectPlaybackSetting(page, '字幕', /^Bitmap/)
    assert.equal(await page.getByRole('button', { name: '字幕字号', exact: true }).isDisabled(), true)
    await selectPlaybackSetting(page, '字幕', /^Styled/)
    assert.equal(await page.getByRole('button', { name: '字幕字号', exact: true }).isDisabled(), true)
    await selectPlaybackSetting(page, '字幕', '关闭字幕')
    await closePlaybackSettings(page)
    await closePlaybackSettings(page)
    await revealControls()
    await openPlaybackSettings(page, '信息')
    await openPlaybackSettings(page, '字幕')
    await closePlaybackSettings(page)
    await revealControls()
    assert.equal(await page.getByRole('button', { name: '播放设置', exact: true }).getAttribute('aria-expanded'), 'false')
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [
      { kind: 'track', type: 'audio', id: 2 }, { kind: 'track', type: 'audio', id: null }, { kind: 'track', type: 'audio', id: 1 },
      { kind: 'speed', value: 1.5 }, { kind: 'seek', seconds: 24 },
      { kind: 'track', type: 'sub', id: 4 }, { kind: 'subtitle-size', value: 40 },
      { kind: 'track', type: 'sub', id: 5 }, { kind: 'track', type: 'sub', id: 3 }, { kind: 'track', type: 'sub', id: null }
    ])
    await openPlaybackSettings(page)
    const commandsBeforeDismiss = await page.evaluate(() => window.fixtureCommands.length)
    await page.getByRole('button', { name: '视频画面，关闭播放设置', exact: true }).click()
    assert.equal(await page.locator('aside[aria-label="播放设置"]').count(), 0)
    await page.waitForTimeout(650)
    assert.equal(await page.evaluate(() => window.fixtureCommands.length), commandsBeforeDismiss,
      'clicking video while settings are open must not pause, resume or restart playback')
    await revealControls()
    if (fullscreen) {
      await page.getByRole('slider', { name: '播放进度', exact: true }).waitFor({ state: 'visible' })
      const session = await page.context().newCDPSession(page)
      const { nodes } = await session.send('Accessibility.getFullAXTree')
      for (const [role, name] of [['slider', '播放进度'], ['slider', '音量'], ['button', '播放'], ['button', '退出全屏'], ['button', '播放设置']]) {
        assert.ok(nodes.some(node => !node.ignored && node.role?.value === role && node.name?.value === name),
          `the actual accessibility tree must expose ${role}/${name}`)
      }
      await session.detach()
      await page.getByRole('button', { name: '视频画面，单击播放或暂停，双击全屏', exact: true }).focus()
      await page.keyboard.press('Tab')
      assert.equal(await page.getByRole('slider', { name: '播放进度', exact: true }).evaluate(element => document.activeElement === element), true,
        'Tab must enter the real shared progress control')
      await page.keyboard.press('ArrowRight')
      const progressVolume = Number(await page.getByRole('slider', { name: '音量', exact: true }).inputValue())
      await page.keyboard.press('ArrowUp')
      assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'volume', value: progressVolume + 5 },
        'ArrowUp adjusts volume even when the progress slider owns focus')
      await page.getByRole('slider', { name: '音量', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      await page.getByRole('button', { name: '播放', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: '暂停', exact: true }).waitFor()
      await page.getByRole('button', { name: '暂停', exact: true }).click()
      await page.getByRole('button', { name: '静音', exact: true }).click()
      await page.getByRole('button', { name: '取消静音', exact: true }).waitFor()
      await page.waitForFunction(() => window.fixtureViewports.some(value => value.presentation === 'fullscreen'
        && value.visible && value.rect.width > 0 && value.rect.height > 0))
      assert.equal(await page.evaluate(() => window.fixtureViewports.some(value => Object.hasOwn(value, 'occlusions'))), false,
        'HTML fullscreen controls keep a complete Canvas viewport without native cutouts')
      await page.getByRole('button', { name: '退出全屏', exact: true }).click()
      await page.getByRole('button', { name: '全屏', exact: true }).click()
      await page.mouse.move(viewport.width / 2, 5)
      await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
      await page.getByRole('button', { name: '恢复展开', exact: true }).click()
      await page.getByRole('button', { name: '停止播放', exact: true }).click()
      await page.getByRole('dialog', { name: '内置播放器', exact: true }).waitFor({ state: 'hidden' })
      assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).slice(10), [
        { kind: 'seek', seconds: 29 }, { kind: 'volume', value: 55 }, { kind: 'seek', relative: true, seconds: 5 },
        { kind: 'pause', paused: false }, { kind: 'pause', paused: true }, { kind: 'mute', muted: true },
        { kind: 'presentation', value: 'expanded' }, { kind: 'presentation', value: 'fullscreen' },
        { kind: 'presentation', value: 'docked' }, { kind: 'presentation', value: 'expanded' }, { kind: 'stop' }
      ])
    }
    assert.deepEqual(errors, [])
    console.log(`Playback settings portal select UI: ${viewport.width}x${viewport.height}/${fullscreen ? 'fullscreen AX/keyboard/controls/Canvas' : 'expanded'} PASS (synthetic RPC, no native decoder or screen-reader claim)`)
    await page.close()
    }
  }
  for (const fullscreen of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/playback-settings.html${fullscreen ? '?fullscreen=1' : ''}`)
    if (fullscreen) {
      await page.getByRole('dialog', { name: '内置播放器', exact: true }).waitFor()
      await page.mouse.move(640, 400)
      await page.mouse.move(640, 795)
      await page.getByRole('button', { name: '播放设置', exact: true }).waitFor({ state: 'visible' })
    }
    await openPlaybackSettings(page)
    await page.getByRole('button', { name: '播放设置', exact: true }).click()
    assert.equal(await page.locator('aside[aria-label="播放设置"]').count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      '视频画面，单击播放或暂停，双击全屏',
      'closing settings from its toolbar button restores focus to the video control')
    await openPlaybackSettings(page)
    await page.getByRole('tab', { name: '字幕', exact: true }).click()
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('aside[aria-label="播放设置"]').count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      '视频画面，单击播放或暂停，双击全屏',
      'closing settings from a tab restores focus to the video control without clicking it')
    await page.keyboard.press('ArrowRight')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'seek', relative: true, seconds: 5 })
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('ArrowLeft')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'seek', relative: true, seconds: -5 },
      'player shortcuts still work when browser focus has fallen back to the page')
    if (fullscreen) {
      await page.mouse.move(640, 400)
      await page.waitForFunction(() => document.querySelector('[data-playback-session]')?.getAttribute('data-controls-visible') === 'false')
      await page.keyboard.press('ArrowRight')
      assert.equal(await page.locator('[data-playback-session]').getAttribute('data-controls-visible'), 'true',
        'a fullscreen keyboard shortcut reveals controls hidden by the inactivity timer')
    }
    if (fullscreen) await page.mouse.move(640, 795)
    const volumeSlider = page.getByRole('slider', { name: '音量', exact: true })
    await volumeSlider.click()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      '视频画面，单击播放或暂停，双击全屏',
      'pointer volume adjustment returns focus to playback shortcuts')
    await page.keyboard.press('ArrowRight')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'seek', relative: true, seconds: 5 })
    await volumeSlider.focus()
    const focusedVolume = Number(await volumeSlider.inputValue())
    const beforeKeyboardVolume = await page.evaluate(() => window.fixtureCommands.length)
    await page.keyboard.press('ArrowRight')
    assert.equal((await page.evaluate(() => window.fixtureCommands)).length, beforeKeyboardVolume + 1)
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'seek', relative: true, seconds: 5 },
      'ArrowRight seeks even when the volume slider owns focus')
    assert.equal(Number(await volumeSlider.inputValue()), focusedVolume,
      'seeking must not change the focused volume slider')
    await page.keyboard.press('Shift+ArrowLeft')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'seek', relative: true, seconds: -30 },
      'Shift+ArrowLeft keeps the long seek step while the volume slider owns focus')
    await page.keyboard.press('ArrowUp')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'volume', value: focusedVolume + 5 },
      'ArrowUp changes volume by the player shortcut step while the slider owns focus')
    await page.keyboard.press('ArrowDown')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'volume', value: focusedVolume },
      'ArrowDown restores the previous volume by the same step')
    await page.keyboard.press('Shift+ArrowUp')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'volume', value: focusedVolume + 5 },
      'Shift does not disable the Up/Down volume shortcut')
    if (fullscreen) await page.mouse.move(640, 795)
    const speed = page.getByRole('button', { name: '快捷倍速', exact: true })
    await speed.focus()
    const beforeSelect = await page.evaluate(() => window.fixtureCommands.length)
    await page.keyboard.press('ArrowDown')
    await page.getByRole('listbox').waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => window.fixtureCommands.length), beforeSelect,
      'a focused dropdown owns ArrowDown and does not change playback volume')
    await page.keyboard.press('Escape')
    if (fullscreen) await page.mouse.move(640, 795)
    const settings = page.getByRole('button', { name: '播放设置', exact: true })
    await settings.focus()
    const beforeSettings = await page.evaluate(() => window.fixtureCommands.length)
    await page.keyboard.press('Space')
    await page.locator('aside[aria-label="播放设置"]').waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => window.fixtureCommands.length), beforeSettings,
      'Space activates the focused settings button instead of pausing playback')
    await page.keyboard.press('Escape')
    await page.evaluate(() => document.activeElement?.blur())
    const volumeBeforeShortcuts = Number(await volumeSlider.inputValue())
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).slice(-3), [
      { kind: 'volume', value: volumeBeforeShortcuts + 5 },
      { kind: 'volume', value: volumeBeforeShortcuts + 10 },
      { kind: 'volume', value: volumeBeforeShortcuts + 5 }
    ])
    await page.keyboard.press('Space')
    assert.equal((await page.evaluate(() => window.fixtureCommands)).at(-1)?.kind, 'pause')
    await page.keyboard.press('m')
    assert.equal((await page.evaluate(() => window.fixtureCommands)).at(-1)?.kind, 'mute')
    await page.keyboard.press('f')
    assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).at(-1),
      { kind: 'presentation', value: fullscreen ? 'expanded' : 'fullscreen' })
    console.log(`Playback focus restoration and page-level seek: ${fullscreen ? 'fullscreen' : 'expanded'} PASS`)
    await page.close()
  }
  const dockedPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await dockedPage.goto(`http://127.0.0.1:${server.httpServer.address().port}/playback-settings.html`)
  await dockedPage.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await dockedPage.getByRole('region', { name: '内置播放器', exact: true }).waitFor()
  await dockedPage.evaluate(() => document.activeElement?.blur())
  const dockedCommands = await dockedPage.evaluate(() => window.fixtureCommands.length)
  await dockedPage.keyboard.press('ArrowUp')
  assert.equal(await dockedPage.evaluate(() => window.fixtureCommands.length), dockedCommands,
    'docked playback does not take shortcuts from the surrounding library page')
  await dockedPage.getByRole('button', { name: '静音', exact: true }).focus()
  await dockedPage.keyboard.press('ArrowUp')
  assert.deepEqual((await dockedPage.evaluate(() => window.fixtureCommands)).at(-1), { kind: 'volume', value: 55 },
    'focused docked playback retains its own volume shortcut')
  await dockedPage.close()
  console.log('Docked playback shortcut ownership: PASS')
} finally {
  await browser?.close()
  await server?.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
