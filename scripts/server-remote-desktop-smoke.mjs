// Real Electron settings and pairing against the production Docker server.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import sharp from 'sharp'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-remote-desktop-'))
const userData = path.join(root, 'desktop')
const config = path.join(root, 'config')
const output = process.env.JAVDEX_WEB_QA_OUTPUT || path.join(root, 'evidence')
for (const dir of [userData, config, output]) fs.mkdirSync(dir, { recursive: true })
const name = `javdex-remote-gui-${process.pid}`
const port = Number(process.env.JAVDEX_REMOTE_SMOKE_PORT ?? 18095)
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'invalid JAVDEX_REMOTE_SMOKE_PORT')
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}
fs.writeFileSync(path.join(config, 'server.json'), JSON.stringify({
  listenHost: '0.0.0.0', port, accessHosts: ['127.0.0.1'],
  dataDir: '/data', imagesDir: '/data/media_assets', staticRoot: '/app/web', mediaMounts: { library: '/media' },
  web: { username: 'viewer' }
}))
if (process.env.JAVDEX_REMOTE_SMOKE_SCRAPE === '1') {
  const pluginDir = path.join(userData, 'scraper_plugins', 'video', 'GUI Fixture')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ schemaVersion: 1, kind: 'video', name: 'GUI Fixture', version: '1.0.0', entry: 'index.cjs', supportedFields: ['title', 'summary'] }))
  fs.writeFileSync(path.join(pluginDir, 'index.cjs'), "module.exports = { async parseVideo(ctx) { return { code: ctx.code, title: 'GUI scraped title', summary: 'GUI scraped summary' } } }")
  const pendingDir = path.join(userData, 'scraper_plugins', 'video', 'GUI Pending')
  fs.mkdirSync(pendingDir, { recursive: true })
  fs.writeFileSync(path.join(pendingDir, 'plugin.json'), JSON.stringify({ schemaVersion: 1, kind: 'video', name: 'GUI Pending', version: '1.0.0', entry: 'index.cjs', supportedFields: ['title', 'summary'] }))
  fs.writeFileSync(path.join(pendingDir, 'index.cjs'), "module.exports = { async parseVideo(ctx) { return [{ code: ctx.code, title: 'GUI candidate A', summary: 'GUI chosen summary', sourceUrl: 'https://example.test/a' }, { code: ctx.code, title: 'GUI candidate B', summary: 'GUI other summary', sourceUrl: 'https://example.test/b' }] } }")
}
let application
let started = false
try {
  docker('create', '--name', name, '-p', `${port}:${port}`,
    '-e', 'JAVDEX_WEB_PASSWORD=remote desktop smoke password',
    'javdex-server:smoke', 'start', '--config', '/app/gui-server.json')
  started = true
  docker('cp', path.join(config, 'server.json'), `${name}:/app/gui-server.json`)
  docker('start', name)
  const base = `http://127.0.0.1:${port}`
  let ready = false
  let readinessError = ''
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/live').then(async r => { readinessError = `${r.status} ${await r.text()}`; return r.ok }).catch(error => { readinessError = String(error.cause ?? error); return false })) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, `${readinessError}; ${docker('logs', name)}`)
  const token = JSON.parse(docker('exec', name, 'node', 'index.js', 'bind', '--config', '/app/gui-server.json')).oneTimeToken
  fs.writeFileSync(path.join(userData, 'this-computer.json'), JSON.stringify({ mode: 'remote', remoteBaseUrl: base }))
  const env = { ...process.env, JAVDEX_TEST_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const launch = async () => {
    const executablePath = process.env.JAVDEX_DESKTOP_EXECUTABLE
    application = await electron.launch({ ...(executablePath ? { executablePath, args: process.env.JAVDEX_REMOTE_SMOKE_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] } : { args: ['.'] }), env })
    const page = await application.firstWindow()
    page.setDefaultTimeout(20000)
    await page.waitForFunction(() => Boolean(window.api?.webAccess))
    return page
  }
  let page = await launch()
  await page.evaluate(() => { window.location.hash = '/settings/network/mode' })
  await page.getByLabel(/^一次性领取令牌/).fill(token)
  await page.getByRole('button', { name: '领取写入凭据', exact: true }).click()
  await page.getByText(/远程 · available/).waitFor()
  if (process.env.JAVDEX_REMOTE_SMOKE_NFO === '1') {
    const media = path.join(root, 'media')
    fs.mkdirSync(media)
    if (process.env.JAVDEX_REMOTE_SMOKE_RENAME === '1') fs.writeFileSync(path.join(media, 'unidentified.strm'), 'https://example.test/unidentified.mp4')
    fs.writeFileSync(path.join(media, 'GUI-901.strm'), 'https://example.test/fixture.mp4')
    fs.writeFileSync(path.join(media, 'GUI-901.nfo'), '<movie><num>GUI-901</num><title>GUI imported title</title><plot>GUI imported summary</plot><thumb aspect="poster">poster.png</thumb><actor><name>GUI actor</name></actor></movie>')
    fs.writeFileSync(path.join(media, 'poster.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer())
    docker('cp', `${media}/.`, `${name}:/media/`)
    docker('exec', '--user', '0', name, 'chown', '-R', 'node:node', '/media')
    await page.evaluate(async () => {
      const library = await window.api.mediaLibraries.get(1)
      await window.api.mediaLibraries.updateConfig({ libraryId: 1, expectedRevision: library.config.revision,
        patch: { autoImportLocalNfo: true, minImportDurationMinutes: 0, autoMergeSameCodeResources: true } })
      window.location.hash = '/settings/library/sources?library=1'
    })
    await page.getByRole('button', { name: '添加目录', exact: true }).click()
    await page.getByRole('dialog').getByLabel('挂载名称', { exact: true }).fill('library')
    await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '扫描并导入', exact: true }).click()
    await page.waitForFunction(async () => {
      const result = await window.api.videos.list({ kind: 'library', libraryId: 1 })
      return result.items.some(item => item.code === 'GUI-901' && item.title === 'GUI imported title')
    })
    await page.getByRole('button', { name: '扫描并导入', exact: true }).waitFor()
    const videos = await page.evaluate(() => window.api.videos.list({ kind: 'library', libraryId: 1 }))
    const video = videos.items.find(item => item.code === 'GUI-901')
    assert.ok(video, JSON.stringify(videos))
    assert.equal(video.title, 'GUI imported title')
    await page.evaluate(id => { window.location.hash = `/libraries/1/video/${id}` }, video.id)
    await page.getByText('GUI imported summary', { exact: true }).waitFor()
    await page.screenshot({ path: path.join(output, 'remote-nfo-detail.png'), fullPage: true })
    console.log('PASS: remote sources GUI starts a container scan and opens imported NFO detail')
    if (process.env.JAVDEX_REMOTE_SMOKE_SCRAPE === '1') {
      await page.getByRole('button', { name: '修正匹配', exact: true }).click()
      await page.getByRole('dialog').getByTitle('刮削站点', { exact: true }).click()
      await page.getByRole('option', { name: 'GUI Fixture', exact: true }).click()
      await page.getByRole('dialog').getByText('覆盖更新', { exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: '全选', exact: true }).first().click()
      await page.getByRole('dialog').getByRole('button', { name: '开始修正', exact: true }).click()
      await page.getByText('GUI scraped summary', { exact: true }).waitFor()
      await page.screenshot({ path: path.join(output, 'remote-single-scrape.png'), fullPage: true })
      console.log('PASS: remote GUI applies metadata from a real desktop sandbox plugin')
      if (process.env.JAVDEX_REMOTE_SMOKE_PENDING === '1') {
        await page.getByRole('button', { name: '修正匹配', exact: true }).click()
        await page.getByRole('dialog').getByTitle('刮削站点', { exact: true }).click()
        await page.getByRole('option', { name: 'GUI Pending', exact: true }).click()
        await page.getByRole('dialog').getByText('覆盖更新', { exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: '全选', exact: true }).first().click()
        await page.getByRole('dialog').getByRole('button', { name: '开始修正', exact: true }).click()
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
        await page.getByText(/待确认/).first().waitFor()
        await page.evaluate(() => { window.location.hash = '/pending?type=scrape' })
        await page.getByText('GUI candidate A', { exact: true }).first().click()
        await page.getByRole('button', { name: '应用所选候选', exact: true }).click()
        await page.waitForFunction(async () => (await window.api.videos.list({ kind: 'library', libraryId: 1 })).items.some(item => item.code === 'GUI-901' && item.title === 'GUI candidate A'))
        await page.evaluate(id => { window.location.hash = `/libraries/1/video/${id}` }, video.id)
        await page.getByText('GUI chosen summary', { exact: true }).waitFor()
        console.log('PASS: remote GUI selects and applies a staged scrape candidate')
      }
    }
    if (process.env.JAVDEX_REMOTE_SMOKE_RENAME === '1') {
      await page.evaluate(() => { window.location.hash = '/settings/library/sources?library=1' })
      await page.getByText('重命名源文件并重新识别', { exact: true }).click()
      await page.getByLabel('unidentified.strm 新文件名', { exact: true }).fill('GUI-902')
      await page.getByRole('button', { name: '重命名并导入', exact: true }).click()
      await page.getByText('已重命名并导入：GUI-902', { exact: true }).waitFor()
      docker('exec', name, 'test', '-f', '/media/GUI-902.strm')
      docker('exec', name, 'test', '!', '-e', '/media/unidentified.strm')
      await page.screenshot({ path: path.join(output, 'remote-rename.png'), fullPage: true })
      console.log('PASS: remote GUI renames an actual server file and imports its new identity')
    }
  }
  await page.evaluate(() => { window.location.hash = '/settings/network/web' })
  await page.getByRole('button', { name: '开启配对', exact: true }).click()
  assert.equal(await page.getByLabel('端口', { exact: true }).count(), 0)
  const post = (url, body, cookie) => fetch(base + url, { method: 'POST', headers: {
    Origin: base, 'X-Javdex-Client': 'web', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {})
  }, body: JSON.stringify(body) })
  const start = await post('/api/pair/start', { name: 'Remote GUI phone', remember: true })
  assert.equal(start.status, 200)
  const pairingCookie = start.headers.get('set-cookie').split(';')[0]
  const pair = await start.json()
  await page.getByLabel('新设备显示的配对码').fill(pair.code)
  await page.getByRole('button', { name: '核对设备', exact: true }).click()
  await page.getByRole('button', { name: '允许登录', exact: true }).click()
  const exchange = await post('/api/pair/poll', {}, pairingCookie)
  assert.equal(exchange.status, 200)
  const browserCookie = exchange.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(base + '/api/videos', { headers: { Cookie: browserCookie } })).status, 200)
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByText(/Remote GUI phone ·/).waitFor()
  await page.screenshot({ path: path.join(output, 'remote-pairing.png'), fullPage: true })
  await application.close()
  application = null
  docker('restart', name)
  page = await launch()
  await page.evaluate(() => { window.location.hash = '/settings/network/web' })
  await page.getByText(/Remote GUI phone/).first().waitFor()
  assert.equal((await fetch(base + '/api/videos', { headers: { Cookie: browserCookie } })).status, 200)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal((await fetch(base + '/api/videos', { headers: { Cookie: browserCookie } })).status, 401)
  assert.equal(fs.existsSync(path.join(userData, 'library.db')), false, 'remote desktop must not open a local catalog')
  console.log(`PASS: production container + native remote desktop writer claim, pairing, restart, revoke; evidence ${output}`)
} catch (error) {
  if (application) {
    for (const page of application.windows()) {
      console.error(await page.locator('body').innerText())
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    }
  }
  throw error
} finally {
  if (application) await application.close()
  if (started) docker('rm', '-fv', name)
  // Keep isolated fixture and screenshots for inspection; never touches the user's library.
}
