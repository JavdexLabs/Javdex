import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { installStableScreenshots } from './lib/stable-screenshot.mjs'

const repo = process.cwd()
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-whole-pages-'))
const stackContexts = [
  { name: 'home', videoPrefix: '/home/video', back: '/', depth: 1 },
  { name: 'search', videoPrefix: '/search/video', back: '/search', depth: 1, query: '?q=FIX&lib=3', backQuery: { q: 'FIX' } },
  { name: 'pending', videoPrefix: '/pending/video', back: '/pending', depth: 1 },
  { name: 'actress', videoPrefix: '/actresses/1', back: '/actresses/1', depth: 2 },
  { name: 'playlist', videoPrefix: '/playlists/1', back: '/playlists/1', depth: 2 },
  ...[['director', 'd'], ['series', 's'], ['maker', 'o'], ['publisher', 'o']].map(([name, segment]) =>
    ({ name, videoPrefix: `/facet/${name}/${segment}/1`, back: `/facet/${name}/${segment}/1`, depth: 2 }))
]
const surfaces = [
  { name: 'library', route: '/libraries/3', search: '搜索', method: 'videos.list', ready: 'FIX-001', empty: '媒体库为空', error: '读取影片失败' },
  { name: 'actresses', route: '/actresses', search: '搜索演员', method: 'actresses.listPage', ready: '样式验收演员 1：长名称', empty: '暂无演员数据', error: '演员列表加载失败' },
  { name: 'playlists', route: '/playlists', search: '搜索清单', method: 'playlists.listPage', ready: '样式验收清单 1：较长中文名称', empty: '暂无清单', error: '播放清单加载失败' },
  ...[['director', '导演', 'directors'], ['series', '系列', 'series'], ['maker', '制作商', 'organizations'], ['publisher', '发行商', 'organizations']].map(([name, label, group]) =>
    ({ name, route: `/facet/${name}`, search: `搜索${label}`, method: `${group}.page`, ready: '样式验收分类 1：较长中文名称', empty: `暂无${label}资料`, error: `${label}加载失败` })),
  { name: 'pending', route: '/pending', ready: '没有待确认项', error: '待确认扫描读取失败', states: ['ready', 'loading', 'error'] },
  ...[
    ['scan', 'scan:11', 'scan.getPendingGroup', 'FIX-001 · 确认资源归属', '正在读取扫描详情…', '扫描详情读取失败'],
    ['identity', 'scan:identity-12', 'scan.getPendingIdentity', '确认番号', '正在读取扫描详情…', '扫描详情读取失败'],
    ['scrape', 'scrape:21', 'scrape.getPending', '选择刮削结果', '正在读取候选…', '候选读取失败'],
    ['actress', 'actress:合成共享名称', 'actressScrape.getConflict', '合成共享名称 · 确认名称归属', '正在读取演员冲突详情…', '演员冲突详情读取失败']
  ].map(([name, item, method, ready, loading, error]) => ({ name: `pending-${name}`, scenario: `pending-${name}`,
    route: `/pending?type=${name === 'identity' ? 'scan' : name}&item=${encodeURIComponent(item)}`,
    method, ready, loading, error, empty: '此待确认项已不存在', pending: name })),
  { name: 'pluginDev', scenario: 'plugin-dev', route: '/settings/plugin-dev', method: 'pluginDev.snapshot',
    ready: '合成恢复消息', empty: '未配置模型', loading: '插件开发用途尚未配置可用模型。', error: '开发工作区模型配置读取失败' },
  { name: 'settings', route: '/settings/overview/status', ready: '影片刮削概览', states: ['ready'] },
  { name: 'appearance', route: '/settings/appearance/theme', ready: '封面比例', states: ['ready'] },
  { name: 'plugins', route: '/settings/plugins/video', ready: '暂无影片插件', states: ['ready'] },
  { name: 'librarySettings', route: '/settings/library/sources?library=3', ready: '尚未添加来源目录', states: ['ready'] },
  ...[['general', '身份与侧栏显示'], ['scraping', '默认影片刮削器'], ['display', '媒体库列表默认值'], ['danger', '归档媒体库']].map(([tab, ready]) =>
    ({ name: `librarySettings-${tab}`, route: `/settings/library/${tab}?library=3`, ready, states: ['ready'] })),
  { name: 'actressPlugins', route: '/settings/plugins/actress', ready: '暂无演员插件', states: ['ready'] },
  ...[['usage', '应用默认模型'], ['providers', '先选择下方提供商'], ['advanced', '当前没有可编辑的生成模型']].map(([tab, ready]) =>
    ({ name: `models-${tab}`, route: `/settings/models/${tab}`, ready, method: 'settings.getModelManagement', states: ['ready'] })),
  { name: 'catalogConnection', route: '/settings/storage/mode', ready: '资料库位置', method: 'thisComputer.get', states: ['ready'] },
  { name: 'storageAssets', route: '/settings/storage/assets', ready: '资源存储', states: ['ready'] },
  { name: 'backup', route: '/settings/storage/backup', ready: '操作记录 · 0', method: 'backup.control', states: ['ready'] },
  { name: 'nfoExport', route: '/settings/storage/export', ready: '一次性导出，不自动同步。', method: 'nfoExport.getOptions', states: ['ready'] },
  { name: 'webAccess', route: '/settings/network/web', ready: '服务配置', method: 'webAccess.status', states: ['ready'] },
  { name: 'proxy', route: '/settings/network/proxy', ready: '刮削代理', states: ['ready'] },
  { name: 'about', route: '/settings/about/info', ready: '项目信息', states: ['ready'] },
  { name: 'videoDetail', route: '/libraries/3/video/1', detail: true, back: '/libraries/3', method: 'videos.get', ready: '样式验收影片详情：较长中文标题', empty: '未找到该影片', error: '读取影片失败' },
  { name: 'actressDetail', route: '/actresses/1', detail: true, back: '/actresses', method: 'actresses.profile', ready: '样式验收演员详情：较长中文名称', empty: '未找到该演员', error: '未找到该演员' },
  { name: 'playlistDetail', route: '/playlists/1', detail: true, back: '/playlists', method: 'playlists.metadata', ready: '样式验收清单详情：较长中文名称', empty: '未找到该清单', error: '未找到该清单' },
  ...[['director', 'd', '导演', 'directors'], ['series', 's', '系列', 'series'], ['maker', 'o', '机构', 'organizations'], ['publisher', 'o', '机构', 'organizations']].map(([name, segment, label, group]) =>
    ({ name: `${name}Detail`, route: `/facet/${name}/${segment}/1`, detail: true, back: `/facet/${name}`, method: `${group}.get`, ready: '样式验收分类详情：较长中文名称', empty: `${label}不存在`, error: `${label}资料加载失败` })),
  ...stackContexts.map(context => ({ name: `stackVideo-${context.name}`, scenario: 'stack-video', detail: true,
    route: `${context.videoPrefix}/2${context.query ?? ''}`, back: context.back, backQuery: context.backQuery,
    backAbsentQuery: context.query ? ['lib'] : [],
    depth: context.depth, method: 'videos.get', ready: '样式验收影片详情：较长中文标题', empty: '未找到该影片', error: '读取影片失败' })),
  ...[...stackContexts, { name: 'library', videoPrefix: '/libraries/3/video', depth: 1 }].map(context => ({
    name: `stackActress-${context.name}`, scenario: 'stack-actress', detail: true,
    route: `${context.videoPrefix}/1/actress/2${context.name === 'actress' ? '?relatedVideoOffset=60' : context.query ?? ''}`, back: `${context.videoPrefix}/1`,
    backQuery: context.name === 'actress' ? { relatedVideoOffset: '60' } : context.query ? { q: 'FIX', lib: '3' } : undefined,
    backAbsentQuery: ['actressVideoOffset'], depth: context.depth + 1,
    method: 'actresses.profile', ready: '样式验收演员详情：较长中文名称', empty: '未找到该演员', error: '未找到该演员' })),
  { name: 'stackActress-pendingDirect', scenario: 'stack-actress', route: '/pending/actress/2', detail: true,
    back: '/pending', depth: 1, method: 'actresses.profile', ready: '样式验收演员详情：较长中文名称', empty: '未找到该演员', error: '未找到该演员' }
]
// Explicit partial acceptance can leave an independently tracked business failure
// red in the default run. Always disclose omissions; never silently skip a route.
const skippedSurfaces = new Set((process.env.JAVDEX_WHOLE_PAGE_SKIP ?? '').split(',').map(name => name.trim()).filter(Boolean))
for (const name of [...skippedSurfaces, ...(process.env.JAVDEX_WHOLE_PAGE ? [process.env.JAVDEX_WHOLE_PAGE] : [])]) {
  assert.ok(surfaces.some(surface => surface.name === name), `Unknown whole-page surface: ${name}`)
}
let server, browser
const results = []
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/css-module-migration'),
    cacheDir: path.join(output, '.vite'), plugins: [react()],
    // This dependency is imported by the actual appearance worker only after route entry.
    // Discover it up front so Vite does not replace its dependency graph during acceptance.
    optimizeDeps: { include: ['@mediapipe/tasks-vision'] },
    resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const base = `http://127.0.0.1:${server.httpServer.address().port}/whole-pages.html`
  for (const width of [1440, 1000]) for (const theme of ['graphite', 'light']) for (const surface of surfaces) {
    if (process.env.JAVDEX_WHOLE_PAGE && process.env.JAVDEX_WHOLE_PAGE !== surface.name) continue
    if (skippedSurfaces.has(surface.name)) continue
    for (const state of surface.states ?? ['ready', 'empty', 'loading', 'error']) {
      const height = width === 1440 ? 900 : 640
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
      page.setDefaultTimeout(10_000)
      installStableScreenshots(page)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const id = `${surface.name}-${width}-${theme}-${state}`
      try {
        await page.goto(`${base}?theme=${theme}&state=${state}&scenario=${surface.scenario ?? ''}#${surface.route}`)
        await page.locator('aside nav').waitFor()
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
        if (surface.method) await page.waitForFunction(method => window.fixtureCalls.some(call => call.name === method), surface.method)
        if (surface.search) {
          await page.getByRole('searchbox', { name: surface.search, exact: true }).waitFor()
          await page.waitForFunction(method => window.fixtureCalls.some(call => call.name === method), surface.method)
        }
        const scope = surface.detail ? page.locator('[data-detail-pane]').last() : page
        if (surface.depth) await page.waitForFunction(depth => document.querySelectorAll('[data-detail-pane]').length === depth, surface.depth)
        if (state === 'ready') await scope.getByText(surface.ready, { exact: false }).first().waitFor()
        else if (state === 'error') await scope.getByText(surface.error, { exact: false }).first().waitFor()
        else if (state === 'empty') await scope.getByText(surface.empty, { exact: false }).first().waitFor()
        else if (surface.loading) await scope.getByText(surface.loading, { exact: false }).first().waitFor()
        else await scope.getByRole('status').first().waitFor()
        if (surface.detail && state === 'ready' && surface.method !== 'videos.get') {
          await scope.getByText('FIX-001', { exact: true }).first().waitFor()
        }
        await page.screenshot({ path: path.join(output, `${id}.png`), caret: 'hide' })
        // Keep the independently discovered error-contract mismatch red-capable;
        // the geometry matrix does not claim that every business message is correct.
        if (process.env.JAVDEX_WHOLE_PAGE_ERROR_TEXT === '1' && state === 'error') {
          assert.equal(await page.getByText('undefined', { exact: true }).count(), 0, `${id}: missing error message`)
        }
        const metrics = await page.evaluate(() => {
          const aside = document.querySelector('aside').getBoundingClientRect()
          return { sidebarWidth: aside.width, documentWidth: document.documentElement.scrollWidth,
            documentHeight: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight }
        })
        if (surface.depth) {
          metrics.detailDepth = await page.locator('[data-detail-pane]').count()
          assert.equal(metrics.detailDepth, surface.depth)
          if (surface.name === 'stackActress-actress') {
            metrics.actressIds = await page.evaluate(() => [...new Set(window.fixtureCalls
              .filter(call => call.name === 'actresses.profile').map(call => call.args[0]))].sort())
            assert.deepEqual(metrics.actressIds, [1, 2], `${id}: parent and leaf must read distinct actresses`)
            if (state === 'ready') {
              assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('relatedVideoOffset')), '60', `${id}: parent offset survives child initialization`)
            }
          }
          const stacked = await page.locator('[data-detail-pane]').evaluateAll(panes => panes.slice(0, -1).every(pane =>
            pane.dataset.stacked === 'true' && [...pane.children].filter(el => !el.hasAttribute('data-detail-pane-overlay')).every(el =>
              getComputedStyle(el).opacity === '0' && getComputedStyle(el).pointerEvents === 'none')))
          assert.equal(stacked, true, `${id}: parent detail must be visually and pointer obscured`)
        }
        assert.equal(metrics.sidebarWidth, width > 1120 ? 210 : 176)
        assert.equal(metrics.documentWidth, width, `${id}: horizontal overflow`)
        assert.equal(metrics.documentHeight, height, `${id}: outer scroll instead of pane scroll`)
        assert.deepEqual(await page.evaluate(() => window.fixtureUnexpected), [], `${id}: unknown API calls`)
        assert.deepEqual(errors, [], `${id}: browser exceptions`)
        if (surface.search && state === 'ready') {
          const input = page.getByRole('searchbox', { name: surface.search, exact: true })
          await input.focus()
          await page.keyboard.press('Tab')
          const focus = await page.evaluate(() => {
            const el = document.activeElement
            const box = el.getBoundingClientRect()
            return { interactive: el.matches('button, a[href], input, select'), focusVisible: el.matches(':focus-visible'),
              right: box.right, bottom: box.bottom, left: box.left, top: box.top }
          })
          assert.equal(focus.interactive, true)
          assert.equal(focus.focusVisible, true)
          assert.ok(focus.left >= 0 && focus.top >= 0 && focus.right <= width && focus.bottom <= height)
          await page.screenshot({ path: path.join(output, `${id}-focus.png`), caret: 'hide' })
          metrics.focus = focus
          metrics.scroll = await page.evaluate(() => {
            const el = [...document.querySelectorAll('#root div')].find(node =>
              !node.closest('aside') && node.scrollHeight > node.clientHeight + 1 &&
              ['auto', 'scroll'].includes(getComputedStyle(node).overflowY))
            if (!el) return null
            el.setAttribute('data-fixture-scroll-target', '')
            el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.75)
            return { viewportHeight: el.clientHeight, contentHeight: el.scrollHeight, top: el.scrollTop,
              overflowY: getComputedStyle(el).overflowY, gutter: getComputedStyle(el).scrollbarGutter }
          })
          assert.ok(metrics.scroll?.top > 0, `${id}: fixture must exercise the real list scroll container`)
          assert.equal(await page.evaluate(() => scrollY), 0)
          assert.equal(metrics.scroll.gutter, 'stable')
          await page.screenshot({ path: path.join(output, `${id}-scrolled.png`), caret: 'hide' })
          await page.locator('[data-fixture-scroll-target]').evaluate(el => { el.scrollTop = 0 })
          // Style acceptance uses settled scroll geometry. Preserve a separate red-capable
          // rapid-input repro for the existing continuous-list URL/draft race; do not hide it
          // with a production change or call the settled path a race-condition fix.
          if (process.env.JAVDEX_WHOLE_PAGE_RAPID_INPUT !== '1') {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          }
          await input.fill('fixture-no-match')
          await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('q') === 'fixture-no-match')
          await page.getByText('没有匹配', { exact: false }).first().waitFor()
          assert.equal(await input.inputValue(), 'fixture-no-match')
          assert.equal(await input.evaluate(el => el === document.activeElement), true)
          await page.screenshot({ path: path.join(output, `${id}-search-empty.png`), caret: 'hide' })
          await input.fill('')
          await page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1]).has('q'))
          await page.getByText(surface.ready, { exact: false }).first().waitFor()
          await page.screenshot({ path: path.join(output, `${id}-search-restored.png`), caret: 'hide' })
        }
        if (surface.detail && state === 'ready') {
          if (surface.depth > 1) await page.locator('[data-detail-pane]').nth(surface.depth - 2).evaluate(el => { el.dataset.fixtureParentRetained = 'true' })
          const back = scope.getByRole('button', { name: '返回', exact: true })
          await back.focus()
          await page.keyboard.press('Tab')
          await page.keyboard.press('Shift+Tab')
          assert.equal(await back.evaluate(el => el === document.activeElement && el.matches(':focus-visible')), true)
          metrics.focus = await back.evaluate(el => {
            const { left, top, right, bottom } = el.getBoundingClientRect()
            return { left, top, right, bottom, focusVisible: el.matches(':focus-visible') }
          })
          assert.ok(metrics.focus.left >= 0 && metrics.focus.top >= 0 && metrics.focus.right <= width && metrics.focus.bottom <= height)
          await page.screenshot({ path: path.join(output, `${id}-focus.png`), caret: 'hide' })
          metrics.scroll = await scope.evaluate(pane => {
            const el = [...pane.querySelectorAll('div')].find(node =>
              node.scrollHeight > node.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY))
            if (!el) return null
            el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.75)
            return { viewportHeight: el.clientHeight, contentHeight: el.scrollHeight, top: el.scrollTop,
              gutter: getComputedStyle(el).scrollbarGutter }
          })
          if (surface.method !== 'videos.get') assert.ok(metrics.scroll, `${id}: related videos must exercise detail scrolling`)
          if (metrics.scroll) {
            assert.ok(metrics.scroll.top > 0)
            assert.equal(metrics.scroll.gutter, 'stable')
            assert.equal(await page.evaluate(() => scrollY), 0)
            await page.screenshot({ path: path.join(output, `${id}-scrolled.png`), caret: 'hide' })
          }
          // Settled style acceptance is separate from the red-capable rapid-return repro.
          // The latter deliberately preserves scroll/anchor navigation timing.
          if (process.env.JAVDEX_WHOLE_PAGE_RAPID_RETURN !== '1') {
            await scope.evaluate(pane => {
              for (const node of pane.querySelectorAll('div')) {
                if (['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) node.scrollTop = 0
              }
            })
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          }
          await back.click()
          await page.waitForFunction(route => location.hash.split('?')[0] === `#${route}`, surface.back)
          await page.waitForFunction(depth => document.querySelectorAll('[data-detail-pane]').length === depth, (surface.depth ?? 1) - 1)
          if (surface.depth > 1) assert.equal(await page.locator('[data-detail-pane]').last().getAttribute('data-fixture-parent-retained'), 'true', `${id}: parent must stay mounted`)
          if (surface.backQuery) {
            const query = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])))
            for (const [key, value] of Object.entries(surface.backQuery)) assert.equal(query[key], value, `${id}: retained ${key}`)
            for (const key of surface.backAbsentQuery ?? []) assert.equal(key in query, false, `${id}: detail-only ${key} must be removed`)
          }
          await page.screenshot({ path: path.join(output, `${id}-returned.png`), caret: 'hide' })
          assert.equal(await page.evaluate(() => location.hash.split('?')[0]), `#${surface.back}`)
        }
        if ((surface.pending || surface.name === 'pluginDev') && state === 'ready') {
          // Exercise only local presentation state. No confirmation, Agent run,
          // installation, or catalog mutation is exposed by this read-only fixture.
          const focusTarget = surface.name === 'pluginDev'
            ? page.getByRole('button', { name: '连接设置', exact: true })
            : surface.pending === 'scan'
              ? page.getByRole('button', { name: '分配 FIX-001-合成资源-1.mp4', exact: true })
              : surface.pending === 'identity'
                ? page.getByRole('radio', { name: /文件名番号/ })
                : surface.pending === 'scrape'
                  ? page.locator('input[name="source-1"]').first()
                  : page.getByRole('radio', { name: /合成现有演员/ })
          await focusTarget.focus()
          await page.keyboard.press('Tab')
          await page.keyboard.press('Shift+Tab')
          metrics.focus = await focusTarget.evaluate(el => {
            const { left, top, right, bottom } = el.getBoundingClientRect()
            return { left, top, right, bottom, focusVisible: el.matches(':focus-visible') }
          })
          assert.equal(metrics.focus.focusVisible, true)
          assert.ok(metrics.focus.left >= 0 && metrics.focus.top >= 0 && metrics.focus.right <= width && metrics.focus.bottom <= height)
          await page.screenshot({ path: path.join(output, `${id}-focus.png`), caret: 'hide' })
          if (surface.name === 'pluginDev') {
            metrics.scroll = await page.locator('[data-conversation-log]').evaluate(el => {
              el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.5)
              return { top: el.scrollTop, viewportHeight: el.clientHeight, contentHeight: el.scrollHeight,
                gutter: getComputedStyle(el).scrollbarGutter }
            })
            assert.ok(metrics.scroll.top > 0, `${id}: restored messages must exercise conversation scrolling`)
            await page.screenshot({ path: path.join(output, `${id}-scrolled.png`), caret: 'hide' })
            await page.getByRole('button', { name: '查看代码', exact: true }).click()
            await page.getByRole('dialog', { name: '插件代码 · 合成开发插件', exact: true }).waitFor()
            await page.screenshot({ path: path.join(output, `${id}-code.png`), caret: 'hide' })
            await page.keyboard.press('Escape')
            await page.getByRole('dialog').waitFor({ state: 'detached' })
            await page.getByRole('button', { name: '连接设置', exact: true }).click()
            await page.getByRole('dialog', { name: 'Agent 连接配置', exact: true }).waitFor()
            await page.screenshot({ path: path.join(output, `${id}-connection.png`), caret: 'hide' })
            await page.keyboard.press('Escape')
            await page.getByRole('dialog').waitFor({ state: 'detached' })
            const tabs = page.getByRole('tablist', { name: 'Agent 面板', exact: true })
            await tabs.getByRole('tab', { name: '结果', exact: true }).click()
            await page.getByText('暂无运行结果', { exact: true }).waitFor()
            await page.screenshot({ path: path.join(output, `${id}-result.png`), caret: 'hide' })
            await tabs.getByRole('tab', { name: /对话/ }).click()
            const feedback = page.locator('#plugin-dev-panel-conversation').getByRole('textbox')
            await feedback.fill('合成反馈草稿：只检查输入，不发送。')
            assert.equal(await feedback.inputValue(), '合成反馈草稿：只检查输入，不发送。')
          } else if (surface.pending === 'scan') {
            const confirm = page.getByRole('button', { name: '确认全部分配', exact: true })
            assert.equal(await confirm.isDisabled(), true)
            for (let resource = 1; resource <= 8; resource++) {
              await page.getByRole('button', { name: `分配 FIX-001-合成资源-${resource}.mp4`, exact: true }).click()
              await page.getByRole('option', { name: '新建影片 1', exact: true }).click()
            }
            assert.equal(await confirm.isEnabled(), true)
            await page.locator('input[name="primary-1"]').last().check()
            assert.equal(await page.locator('input[name="primary-1"]').last().isChecked(), true)
            await page.screenshot({ path: path.join(output, `${id}-selected.png`), caret: 'hide' })
            await focusTarget.click()
            await page.getByRole('option', { name: '选择归属…', exact: true }).click()
            assert.equal(await confirm.isDisabled(), true)
          } else if (surface.pending === 'identity') {
            const confirm = page.getByRole('button', { name: '确认番号', exact: true })
            assert.equal(await confirm.isDisabled(), true)
            await focusTarget.check()
            assert.equal(await confirm.isEnabled(), true)
            await page.getByRole('radio', { name: /本地 NFO 番号/ }).check()
            await page.screenshot({ path: path.join(output, `${id}-selected.png`), caret: 'hide' })
            await page.getByText('更多处理', { exact: true }).click()
            await page.getByRole('button', { name: '丢弃待办', exact: true }).click()
            await page.getByRole('dialog', { name: '丢弃这条待办？', exact: true }).waitFor()
            await page.screenshot({ path: path.join(output, `${id}-discard-preview.png`), caret: 'hide' })
            await page.keyboard.press('Escape')
            await page.getByRole('dialog').waitFor({ state: 'detached' })
          } else if (surface.pending === 'scrape') {
            const confirm = page.getByRole('button', { name: '应用所选候选', exact: true })
            assert.equal(await confirm.isDisabled(), true)
            await focusTarget.check()
            assert.equal(await confirm.isEnabled(), true)
            await page.screenshot({ path: path.join(output, `${id}-selected.png`), caret: 'hide' })
            await page.getByText('更多处理', { exact: true }).click()
            await page.getByRole('button', { name: '丢弃全部候选', exact: true }).click()
            await page.getByRole('dialog', { name: '丢弃影片刮削候选？', exact: true }).waitFor()
            await page.screenshot({ path: path.join(output, `${id}-discard-preview.png`), caret: 'hide' })
            await page.keyboard.press('Escape')
            await page.getByRole('dialog').waitFor({ state: 'detached' })
          } else {
            await focusTarget.check()
            await page.getByText('拟定归属：合成现有演员', { exact: true }).waitFor()
            await page.screenshot({ path: path.join(output, `${id}-selected.png`), caret: 'hide' })
            await page.getByRole('tab', { name: '来源详情', exact: true }).click()
            await page.locator('#actress-conflict-panel-source').waitFor()
            await page.screenshot({ path: path.join(output, `${id}-source.png`), caret: 'hide' })
            await page.getByRole('tab', { name: '处理', exact: true }).click()
          }
          assert.equal(await page.evaluate(() => scrollY), 0)
        }
        assert.deepEqual(await page.evaluate(() => window.fixtureUnexpected), [], `${id}: unexpected interaction API`)
        assert.deepEqual(errors, [], `${id}: interaction exceptions`)
        results.push({ name: surface.name, width, height, theme, state, metrics,
          calls: await page.evaluate(() => [...new Set(window.fixtureCalls.map(call => call.name))]) })
      } catch (error) {
        console.error(JSON.stringify({ id, errors, unexpected: await page.evaluate(() => window.fixtureUnexpected ?? []),
          detailPaneCount: await page.locator('[data-detail-pane]').count(),
          location: await page.evaluate(() => ({ hash: location.hash, input: document.querySelector('input[type="search"]')?.value })),
          body: await page.locator('body').innerText() }))
        throw error
      } finally { await page.close() }
    }
  }
  assert.ok(results.length > 0, 'No whole-page surfaces were exercised')
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ output, passed: results.length, skippedSurfaces: [...skippedSurfaces] }))
} finally {
  await browser?.close()
  await server?.close()
}
