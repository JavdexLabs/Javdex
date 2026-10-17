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
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [repo] } } })
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
    if (fullscreen) {
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
      await page.getByRole('slider', { name: '音量', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      await page.getByRole('button', { name: '播放', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: '暂停', exact: true }).waitFor()
      await page.getByRole('button', { name: '暂停', exact: true }).click()
      await page.getByRole('button', { name: '静音', exact: true }).click()
      await page.getByRole('button', { name: '取消静音', exact: true }).waitFor()
      await page.waitForFunction(() => window.fixtureViewports.some(value => value.presentation === 'fullscreen'
        && value.visible && value.occlusions?.some(area => area.width > 0 && area.height > 0)))
      await page.getByRole('button', { name: '退出全屏', exact: true }).click()
      await page.getByRole('button', { name: '全屏', exact: true }).click()
      await page.mouse.move(viewport.width / 2, 5)
      await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
      await page.getByRole('button', { name: '恢复展开', exact: true }).click()
      await page.getByRole('button', { name: '停止播放', exact: true }).click()
      await page.getByRole('dialog', { name: '内置播放器', exact: true }).waitFor({ state: 'hidden' })
      assert.deepEqual((await page.evaluate(() => window.fixtureCommands)).slice(10), [
        { kind: 'seek', seconds: 29 }, { kind: 'volume', value: 51 },
        { kind: 'pause', paused: false }, { kind: 'pause', paused: true }, { kind: 'mute', muted: true },
        { kind: 'presentation', value: 'expanded' }, { kind: 'presentation', value: 'fullscreen' },
        { kind: 'presentation', value: 'docked' }, { kind: 'presentation', value: 'expanded' }, { kind: 'stop' }
      ])
    }
    assert.deepEqual(errors, [])
    console.log(`Playback settings portal select UI: ${viewport.width}x${viewport.height}/${fullscreen ? 'fullscreen AX/keyboard/controls/cutouts' : 'expanded'} PASS (synthetic RPC, no native decoder or screen-reader claim)`)
    await page.close()
    }
  }
} finally {
  await browser?.close()
  await server?.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
