import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const repository = process.cwd()
const desktopVersion = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version
const readActions = new Set(['status', 'environment'])
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-upgrade-ui-'))

function assertReadCommands(calls) {
  assert.ok(calls.some(call => call.action === 'status'), 'upgrade status remains independent of environment detection')
  assert.ok(calls.some(call => call.action === 'environment'), 'the image environment is queried explicitly')
  for (const call of calls.filter(call => readActions.has(call.action))) assert.deepEqual(call, { action: call.action }, 'read-only queries carry no upgrade target or options')
}

function assertOnlyReadCommands(calls) {
  assertReadCommands(calls)
  assert.ok(calls.every(call => readActions.has(call.action)), 'a blocked upgrade must not check, prepare, import or install a bundle')
}

let server, browser
try {
  server = await createServer({ configFile: false, root: path.join(repository, 'scripts/ui-regression'), cacheDir: path.join(temporary, '.vite'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(repository, 'packages/contracts/src'), react: path.join(repository, 'node_modules/react'), 'react-dom': path.join(repository, 'node_modules/react-dom') } }, server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [repository] } } })
  await server.listen()
  browser = await chromium.launch({ ...(process.env.JAVDEX_BROWSER_EXECUTABLE ? { executablePath: process.env.JAVDEX_BROWSER_EXECUTABLE } : { channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome' }), headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}/server-update.html`
  const card = page.getByRole('region', { name: '服务端升级', exact: true })
  const button = name => card.getByRole('button', { name, exact: true })
  const waitForEnvironment = () => card.locator('dl[aria-label="运行环境版本"][aria-busy="false"]').waitFor()
  const callsFromPage = () => page.evaluate(() => window.updateCalls)
  const holdNextEnvironmentCheck = () => page.evaluate(() => {
    const control = window.api.serverUpdate.control
    let release
    const pending = new Promise(resolve => { release = resolve })
    window.releaseEnvironmentCheck = () => {
      window.api.serverUpdate.control = control
      release()
    }
    window.api.serverUpdate.control = async command => {
      if (command.action === 'environment') await pending
      return control(command)
    }
  })
  const assertUpgradeEntriesDisabled = async () => {
    assert.equal(await button('在线升级').isDisabled(), true)
    assert.equal(await button('上传离线包升级').isDisabled(), true)
  }
  await page.goto(`${url}?unpaired=1`)
  await waitForEnvironment()
  await card.getByText('请先在资料库连接中连接此服务端。', { exact: true }).waitFor()
  assert.equal(await card.getByRole('textbox').count(), 0)
  assert.equal(await card.getByRole('button', { name: '在线升级', exact: true }).isDisabled(), true)
  assert.equal(await button('上传离线包升级').isDisabled(), true)
  assertOnlyReadCommands(await callsFromPage())
  for (const state of ['historical', 'partial']) {
    await page.goto(`${url}?${state}=1`)
    await waitForEnvironment()
    const upload = card.getByRole('button', { name: '上传离线包升级', exact: true })
    await upload.waitFor()
    assert.equal(await upload.isEnabled(), true, `${state} state keeps the matching offline-file entry`)
    await upload.click()
    await card.getByRole('button', { name: '确认升级', exact: true }).waitFor()
  }
  await page.goto(`${url}?environment=compatible`)
  await waitForEnvironment()
  await holdNextEnvironmentCheck()
  await button('重新检测').click()
  await card.locator('dl[aria-label="运行环境版本"][aria-busy="true"]').waitFor()
  await assertUpgradeEntriesDisabled()
  assert.equal(await button('重新检测').getAttribute('aria-busy'), 'true')
  assert.equal(await button('重新检测').isDisabled(), true)
  assertOnlyReadCommands(await callsFromPage())
  await page.evaluate(() => window.releaseEnvironmentCheck())
  await waitForEnvironment()
  assert.equal(await button('在线升级').isEnabled(), true)
  assert.equal(await button('上传离线包升级').isEnabled(), true)
  assertOnlyReadCommands(await callsFromPage())

  await page.goto(`${url}?environment=missing&sameVersion=1`)
  await waitForEnvironment()
  await card.getByText('需要升级服务端Docker镜像', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.updateSession.appVersion === window.updateSession.desktopAppVersion), true)
  await assertUpgradeEntriesDisabled()
  assertOnlyReadCommands(await callsFromPage())
  await page.evaluate(() => window.setUpdateEnvironment('compatible'))
  await button('重新检测').click()
  await page.waitForFunction(() => window.updateCalls.filter(call => call.action === 'environment').length === 2)
  await card.waitFor({ state: 'hidden' })
  assertOnlyReadCommands(await callsFromPage())

  fs.mkdirSync('out/server-update-ui', { recursive: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }]) {
    await page.setViewportSize(viewport)
    for (const theme of ['light', 'graphite']) {
      for (const environment of ['mismatch', 'missing', 'network', 'higher', 'unavailable']) {
        const parameters = new URLSearchParams({ theme, environment })
        if (environment === 'missing') {
          parameters.set('statusMissing', '1')
          parameters.set('unpaired', '1')
        }
        await page.goto(`${url}?${parameters}`)
        await waitForEnvironment()
        await assertUpgradeEntriesDisabled()
        assertOnlyReadCommands(await callsFromPage())
        const fixture = await page.evaluate(() => window.environmentFixture)
        assert.equal(fixture.actualRequiredVersion, 1, 'the production environment requirement remains revision 1')
        assert.equal(fixture.lowerRevisionIsMock, environment === 'mismatch')
        if (environment === 'mismatch' || environment === 'missing') {
          await card.getByText('需要升级服务端Docker镜像', { exact: true }).waitFor()
          assert.ok((await card.getByRole('status').allTextContents()).every(text => !/请先.*配对|请先在资料库连接中连接/.test(text)), 'legacy status failures must not lead to a pairing dead-end')
          assert.equal(await button('查看镜像升级指引').isEnabled(), true)
          if (environment === 'mismatch') {
            // This fixture alone simulates a future requirement of 2 against image revision 1.
            assert.deepEqual(await card.locator('dl[aria-label="运行环境版本"] dd').allTextContents(), ['修订 1', '修订 2'])
            await button('查看镜像升级指引').click()
            const guide = page.getByRole('dialog', { name: '服务端Docker镜像升级指引', exact: true })
            await guide.waitFor()
            assert.match(await guide.innerText(), /备份重要资料/)
            assert.match(await guide.innerText(), /\/data.*\/program.*图片卷/)
            assert.match(await guide.innerText(), /重新创建容器.*仅拉取镜像或重启旧容器不会应用新镜像/)
            await guide.getByRole('button', { name: '打开官方部署文档', exact: true }).click()
            await page.waitForFunction(() => window.openExternalCalls.length === 1)
            assert.deepEqual(await page.evaluate(() => window.openExternalCalls), ['https://javdexlabs.github.io/Javdex/server/deploy/'])
            await guide.getByRole('button', { name: '关闭', exact: true }).click()
            await guide.waitFor({ state: 'hidden' })
          } else {
            await button('展开详情').click()
            await card.getByText('旧版镜像未提供升级状态接口', { exact: true }).waitFor()
            await button('收起详情').click()
          }
        } else {
          assert.equal(await card.getByText('需要升级服务端Docker镜像', { exact: true }).count(), 0)
          await card.getByText(environment === 'higher' ? '服务端运行环境较新，请升级此客户端' : '无法确认服务端运行环境', { exact: true }).waitFor()
          assert.equal(await button('重新检测').isEnabled(), true)
          if (environment === 'higher') assert.deepEqual(await card.locator('dl[aria-label="运行环境版本"] dd').allTextContents(), ['修订 2', '修订 1'])
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        await page.screenshot({ path: `out/server-update-ui/${theme}-${viewport.width}-environment-${environment}.png`, fullPage: true })
        if (environment === 'network') {
          await button('展开详情').click()
          await card.getByText(/运行环境检测连接超时/).last().waitFor()
          await page.evaluate(() => window.setUpdateEnvironment('compatible'))
          await holdNextEnvironmentCheck()
          await button('重新检测').click()
          await card.locator('dl[aria-label="运行环境版本"][aria-busy="true"]').waitFor()
          await assertUpgradeEntriesDisabled()
          await card.getByText(/运行环境检测连接超时/).last().waitFor()
          await page.evaluate(() => window.releaseEnvironmentCheck())
          await waitForEnvironment()
          assert.equal(await button('在线升级').isEnabled(), true)
          assert.equal(await button('上传离线包升级').isEnabled(), true)
          assert.equal(await card.getByText(/运行环境检测连接超时/).count(), 0)
        }
        assertOnlyReadCommands(await callsFromPage())
      }
      await page.goto(`${url}?theme=${theme}&environment=missing&state=installing`)
      await waitForEnvironment()
      await card.getByRole('list', { name: '升级进度' }).getByText('安装版本', { exact: true }).waitFor()
      await card.getByText('正在安装版本', { exact: true }).waitFor()
      assert.equal(await button('查看镜像升级指引').count(), 0, 'an existing install must not prompt container replacement')
      assert.equal(await button('在线升级').count(), 0)
      assert.equal(await button('确认升级').count(), 0)
      assertOnlyReadCommands(await callsFromPage())
      for (const offline of [false, true]) {
        await page.goto(`${url}?theme=${theme}`)
        await waitForEnvironment()
        await card.getByRole('button', { name: '在线升级', exact: true }).waitFor()
        assert.equal(await card.getByRole('switch').count(), 0)
        assert.equal(await card.getByText('更新授权', { exact: true }).count(), 0)
        const entry = card.getByRole('button', { name: offline ? '上传离线包升级' : '在线升级', exact: true })
        if (!offline) {
          await page.evaluate(() => { window.failUpdateCheck = true })
          await entry.click()
          await card.getByRole('alert').waitFor()
          await card.getByRole('button', { name: '展开详情', exact: true }).click()
          await card.getByText(/发布签名配置/).last().waitFor()
          await page.evaluate(() => { window.failUpdateCheck = false })
        }
        await entry.click()
        await card.getByText('升级包已就绪', { exact: true }).waitFor()
        await card.getByRole('button', { name: '确认升级', exact: true }).click()
        const confirm = page.getByRole('dialog', { name: `升级服务端至 ${desktopVersion}`, exact: true })
        await confirm.waitFor()
        assert.equal(await page.evaluate(() => window.updateCalls.some(call => call.action === 'install')), false)
        await confirm.getByRole('button', { name: '停服并升级', exact: true }).click()
        const progress = card.getByRole('list', { name: '升级进度' })
        await progress.getByText('验证服务', { exact: true }).waitFor()
        assert.equal(await progress.getByText('备份资料库', { exact: true }).count(), 0)
        const allCalls = await callsFromPage()
        assertReadCommands(allCalls)
        const calls = allCalls.filter(call => !readActions.has(call.action))
        assert.deepEqual(calls.map(call => call.action), offline ? ['import', 'install'] : ['check', 'check', 'prepare', 'install'])
        assert.ok(calls.every(call => call.targetVersion === desktopVersion))
        assert.ok(allCalls.every(call => !Object.hasOwn(call, 'backupBeforeUpgrade')))
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        fs.mkdirSync('out/server-update-ui', { recursive: true })
        await page.screenshot({ path: `out/server-update-ui/${theme}-${viewport.width}-${offline ? 'offline' : 'online'}.png`, fullPage: true })
        await page.evaluate(() => { window.failUpdateReconnects = 2; window.finishServerUpdate() })
        await page.waitForFunction(() => window.updateReconnects === 3 && window.updateSession.state === 'available')
        await card.waitFor({ state: 'hidden' })
        await page.waitForTimeout(2100)
        assert.equal(await page.evaluate(() => window.updateReconnects), 3)
      }
    }
  }
  assert.deepEqual(errors, [])
  console.log(`Server upgrade UI passed: exact ${desktopVersion} target, strict environment gate, read-only detection, legacy/missing/network/newer-image states, same-version and retry checks, both entries, no upgrade backup, confirmation, errors, progress, reconnect retry, 2 sizes and 2 themes (fixture RPC, production components).`)
} finally { await browser?.close(); await server?.close(); fs.rmSync(temporary, { recursive: true, force: true }) }
