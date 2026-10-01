import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { checkAppearance } from './css-module-migration/appearance-check.mjs'
import { checkResourceImport } from './css-module-migration/resource-import-check.mjs'
import { checkDetailOperations } from './css-module-migration/detail-operations-check.mjs'
import { checkSettingsDensity } from './css-module-migration/settings-density-check.mjs'
import { checkScrapeActions } from './css-module-migration/scrape-actions-check.mjs'
import { checkStyleGeometry } from './css-module-migration/geometry-check.mjs'
import { checkPluginDevPanel } from './css-module-migration/plugin-dev-panel-check.mjs'
import { checkAppShell } from './css-module-migration/app-shell-check.mjs'
import { checkSharedChrome } from './css-module-migration/shared-chrome-check.mjs'
import { checkNativeEditor } from './css-module-migration/native-editors-check.mjs'
import { installStableScreenshots } from './lib/stable-screenshot.mjs'

const repo = process.cwd()
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-css-modules-'))
let server, browser
const results = []
const requestedFixtures = new Set((process.env.JAVDEX_CSS_FIXTURE ?? '').split(',').map(name => name.trim()).filter(Boolean))
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/css-module-migration'),
    cacheDir: path.join(output, '.vite'), plugins: [react(), {
      name: 'appearance-fixture-adapters',
      transform(code, id) {
        if (id === path.join(repo, 'apps/desktop/src/renderer/src/contexts/AvatarAutoCropBatchContext.tsx'))
          return code.replace('const context = useContext(Context)', 'const context = useContext(Context) ?? window.fixtureAvatarBatch')
        if (id === path.join(repo, 'apps/desktop/src/renderer/src/avatarAutoCrop/service.ts'))
          return code.replace('const requestId = ++requestSequence', `if (window.fixtureAvatarAnalysisMode === 'pending') return new Promise(() => {});
  if (window.fixtureAvatarAnalysisMode === 'error') return Promise.reject(new Error('Synthetic analysis unavailable'));
  const requestId = ++requestSequence`)
      }
    }],
    resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const width of [1440, 1000, 640, 480]) for (const theme of ['graphite', 'light']) for (const name of ['home', 'search', 'controls', 'grid', 'covers', 'playlistCards', 'playlistPicker', 'playlistDetail', 'detailTitles', 'detailSections', 'videoTags', 'videoInfo', 'classificationCards', 'aliasTagEditor', 'pluginFieldTags', 'pluginDevConfigCreate', 'pluginDevConfigDebug', 'pluginDevTargetVideo', 'pluginDevTargetActress', 'pluginDevConversationActive', 'pluginDevConversationEmpty', 'pluginDevAgentRail', 'pluginDevWorkspaceSettings', 'pluginDevWorkspaceStandalone', 'appFormField', 'codeEditorSyntax', 'pluginDevCodeModal', 'pluginDevKindToggle', 'entityEditForm', 'entityMediaSection', 'imageImportField', 'actressAvatarEditor', 'scrapeFieldsModal', 'sharedChrome', 'appShell', 'pluginDevPanelSettings', 'pluginDevPanelStandalone', 'styleGeometry', 'batchTaskControls', 'batchSettingsEmpty', 'batchSettingsRunning', 'batchSettingsPaused', 'settingsEmptyVariants', 'settingsLoading', 'actressConflict', 'conflictMerge', 'conflictMergeBlocked', 'deleteSeries', 'deleteDirector', 'deleteOrganization', 'deleteRole', 'deleteRoleBlocked', 'deleteImpactError', 'deleteImpactLoading', 'galleryPaging', 'avatarGalleryPaging', 'settingsDensityWorkspace', 'settingsDensityStandalone', 'settingsDensityPanels', 'nativeEditorDirector', 'nativeEditorDirectorWorkspace', 'nativeEditorSeries', 'nativeEditorOrganization', 'nativeEditorPlaylist', 'nativeEditorVideo', 'nativeEditorActress', 'videoDetailOperations', 'videoDetailLastLocal', 'videoDetailLastStrm', 'resourceImportSingle', 'resourceImportLibrary', 'resourceImportEdit', 'resourceImportStrm', 'resourceImportRemote', 'appearanceReady', 'appearancePending', 'appearanceError', 'imagePreview', 'imagePreviewWindow', 'imagePreviewMissing', 'classificationMerge', 'classificationMergeEmpty', 'classificationMergeError', 'directorChoice', 'actressMerge', 'actressMergeEmpty', 'actressMergeError', 'pluginsSettingsEmpty', 'pluginsSettingsCards', 'pluginConfigBuiltin', 'pluginConfigUser', 'scrapeCoverage', 'settingsStatusCards', 'batchOverview', 'settingsWorkspaceShell', 'appUpdate', 'appUpdateIgnored', 'settingsOverview', 'settingsOverviewEmpty', 'settingsOverviewNotices', 'pluginConnectionNotice', 'actressDeleteNotice', 'classificationPickerError', 'classificationDetailLayout', 'classificationProfileDirector', 'classificationProfileSeries', 'classificationProfileOrganization', 'relatedLinksEditor', 'videoTitle', 'videoResources', 'videoMeta', 'detailActions', 'detailPane', 'detailScroll', 'listDetailShell', 'galleryTiles', 'actressProfileMeta', 'actressHeader', 'actressGrid', 'faceScan', 'crypto', 'imageImport', 'selection']) {
    if (requestedFixtures.size && !requestedFixtures.has(name)) continue
    if (width === 640 && name !== 'styleGeometry' && !name.startsWith('pluginDevPanel') && !['selection', 'imageImport', 'playlistPicker', 'playlistDetail', 'detailTitles', 'detailSections', 'videoTags', 'videoInfo', 'classificationCards', 'aliasTagEditor', 'pluginFieldTags', 'pluginDevConfigCreate', 'pluginDevConfigDebug', 'pluginDevTargetVideo', 'pluginDevTargetActress', 'pluginDevConversationActive', 'pluginDevConversationEmpty', 'pluginDevAgentRail', 'pluginDevWorkspaceSettings', 'pluginDevWorkspaceStandalone', 'appFormField', 'codeEditorSyntax', 'pluginDevCodeModal', 'pluginDevKindToggle', 'entityEditForm', 'entityMediaSection', 'imageImportField', 'actressAvatarEditor', 'scrapeFieldsModal', 'sharedChrome', 'appShell', 'batchTaskControls', 'batchSettingsEmpty', 'batchSettingsRunning', 'batchSettingsPaused', 'settingsEmptyVariants', 'settingsLoading', 'actressConflict', 'conflictMerge', 'conflictMergeBlocked', 'deleteSeries', 'deleteDirector', 'deleteOrganization', 'deleteRole', 'deleteRoleBlocked', 'deleteImpactError', 'deleteImpactLoading', 'galleryPaging', 'avatarGalleryPaging', 'settingsDensityWorkspace', 'settingsDensityStandalone', 'settingsDensityPanels', 'nativeEditorDirector', 'nativeEditorDirectorWorkspace', 'nativeEditorSeries', 'nativeEditorOrganization', 'nativeEditorPlaylist', 'nativeEditorVideo', 'nativeEditorActress', 'videoDetailOperations', 'videoDetailLastLocal', 'videoDetailLastStrm', 'resourceImportSingle', 'resourceImportLibrary', 'resourceImportEdit', 'resourceImportStrm', 'resourceImportRemote', 'appearanceReady', 'appearancePending', 'appearanceError', 'imagePreview', 'imagePreviewWindow', 'imagePreviewMissing', 'classificationMerge', 'classificationMergeEmpty', 'classificationMergeError', 'directorChoice', 'actressMerge', 'actressMergeEmpty', 'actressMergeError', 'pluginsSettingsEmpty', 'pluginsSettingsCards', 'pluginConfigBuiltin', 'pluginConfigUser', 'scrapeCoverage', 'settingsStatusCards', 'batchOverview', 'settingsWorkspaceShell', 'appUpdate', 'appUpdateIgnored', 'settingsOverview', 'settingsOverviewEmpty', 'settingsOverviewNotices', 'pluginConnectionNotice', 'actressDeleteNotice', 'classificationPickerError', 'classificationDetailLayout', 'classificationProfileDirector', 'classificationProfileSeries', 'classificationProfileOrganization', 'relatedLinksEditor', 'videoTitle', 'videoResources', 'videoMeta', 'detailActions', 'detailPane', 'detailScroll', 'listDetailShell', 'galleryTiles', 'actressProfileMeta', 'actressHeader'].includes(name)) continue
    if (width === 480 && name !== 'styleGeometry' && !name.startsWith('pluginDevPanel') && !['actressHeader', 'detailSections', 'videoTags', 'videoInfo', 'classificationCards', 'aliasTagEditor', 'pluginFieldTags', 'pluginDevConfigCreate', 'pluginDevConfigDebug', 'pluginDevTargetVideo', 'pluginDevTargetActress', 'pluginDevConversationActive', 'pluginDevConversationEmpty', 'pluginDevAgentRail', 'pluginDevWorkspaceSettings', 'pluginDevWorkspaceStandalone', 'appFormField', 'codeEditorSyntax', 'pluginDevCodeModal', 'pluginDevKindToggle', 'entityEditForm', 'entityMediaSection', 'imageImportField', 'actressAvatarEditor', 'scrapeFieldsModal', 'sharedChrome', 'appShell', 'batchTaskControls', 'batchSettingsEmpty', 'batchSettingsRunning', 'batchSettingsPaused', 'settingsEmptyVariants', 'settingsLoading', 'actressConflict', 'conflictMerge', 'conflictMergeBlocked', 'deleteSeries', 'deleteDirector', 'deleteOrganization', 'deleteRole', 'deleteRoleBlocked', 'deleteImpactError', 'deleteImpactLoading', 'galleryPaging', 'avatarGalleryPaging', 'settingsDensityWorkspace', 'settingsDensityStandalone', 'settingsDensityPanels', 'nativeEditorDirector', 'nativeEditorDirectorWorkspace', 'nativeEditorSeries', 'nativeEditorOrganization', 'nativeEditorPlaylist', 'nativeEditorVideo', 'nativeEditorActress', 'videoDetailOperations', 'videoDetailLastLocal', 'videoDetailLastStrm', 'resourceImportSingle', 'resourceImportLibrary', 'resourceImportEdit', 'resourceImportStrm', 'resourceImportRemote', 'appearanceReady', 'appearancePending', 'appearanceError', 'imagePreview', 'imagePreviewWindow', 'imagePreviewMissing', 'classificationMerge', 'classificationMergeEmpty', 'classificationMergeError', 'directorChoice', 'actressMerge', 'actressMergeEmpty', 'actressMergeError', 'pluginsSettingsEmpty', 'pluginsSettingsCards', 'pluginConfigBuiltin', 'pluginConfigUser', 'scrapeCoverage', 'settingsStatusCards', 'batchOverview', 'settingsWorkspaceShell', 'appUpdate', 'appUpdateIgnored', 'settingsOverview', 'settingsOverviewEmpty', 'settingsOverviewNotices', 'pluginConnectionNotice', 'actressDeleteNotice', 'classificationPickerError', 'classificationDetailLayout', 'classificationProfileDirector', 'classificationProfileSeries', 'classificationProfileOrganization', 'relatedLinksEditor', 'videoTitle', 'videoResources', 'videoMeta', 'detailActions'].includes(name)) continue
    const height = width === 1440 ? 900 : 640
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    installStableScreenshots(page)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${name === 'appShell' ? 'app-shell.html' : name.startsWith('pluginDevPanel') ? 'plugin-dev-panel.html' : name === 'styleGeometry' ? 'geometry.html' : ''}?page=${name}&theme=${theme}`)

    if (name === 'styleGeometry') {
      const metrics = await checkStyleGeometry({ page, name, width, theme, output })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name.startsWith('pluginDevPanel')) {
      const metrics = await checkPluginDevPanel({ page, name, width, theme, output })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'appShell') {
      const metrics = await checkAppShell({ page, name, width, theme, output })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name.startsWith('settingsDensity')) {
      const metrics = await checkSettingsDensity({ page, name, width, theme, output })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'sharedChrome') {
      const metrics = await checkSharedChrome({ page, name, width, theme, output })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name.startsWith('nativeEditor')) {
      try {
        await checkNativeEditor({ page, name, width, theme, output })
      } catch (error) {
        console.error(JSON.stringify({ name, errors, text: await page.locator('body').innerText() }))
        throw error
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name.startsWith('videoDetail')) {
      try {
        await checkDetailOperations({ page, name, width, theme, output })
      } catch (error) {
        console.error(JSON.stringify({ name, errors, text: await page.locator('body').innerText() }))
        throw error
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name.startsWith('resourceImport')) {
      await checkResourceImport({ page, name, width, theme, output })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name.startsWith('appearance')) {
      await checkAppearance({ page, name, width, theme, output })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name.startsWith('imagePreview')) {
      const dialog = page.getByRole('dialog', { name: '图片预览验收' })
      const counter = dialog.locator('[data-image-preview-part="counter"]')
      const image = dialog.locator('[data-image-preview-part="image"]')
      const header = dialog.locator('header')
      const snapshot = async suffix => {
        await page.waitForTimeout(200)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), caret: 'hide' })
      }
      await dialog.waitFor()
      await image.evaluate(async img => { if (!img.complete) await new Promise(resolve => img.addEventListener('load', resolve, { once: true })); assertImage(img) ; function assertImage(el) { if (!el.naturalWidth) throw new Error('Fixture image did not load') } })
      await page.waitForTimeout(250)
      assert.equal(await header.evaluate(el => getComputedStyle(el).opacity), '0')
      await snapshot('-hidden')
      await page.keyboard.press('+')
      await dialog.getByRole('button', { name: '关闭预览' }).focus()
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="dialog"] header')).opacity === '1')
      assert.equal(await counter.innerText(), name === 'imagePreviewWindow' ? '61 / 121' : name === 'imagePreviewMissing' ? '2 / 3' : '2 / 22')
      assert.equal(await image.evaluate(el => getComputedStyle(el).transform), 'matrix(1.15, 0, 0, 1.15, 0, 0)')
      await snapshot('-zoom')
      const drag = async (x, y, dx, dy, release = true) => {
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + dx, y + dy, { steps: 5 })
        if (release) await page.mouse.up()
      }
      await drag(width / 2, height / 2, 45, 28)
      assert.equal(await image.evaluate(el => el.style.transform), 'translate3d(45px, 28px, 0px) scale(1.15)')
      await snapshot('-pan')
      await page.keyboard.press('0')
      assert.equal(await dialog.getByRole('button', { name: '还原视图' }).isDisabled(), true)
      await snapshot('')
      if (name === 'imagePreviewWindow') {
        await dialog.getByRole('button', { name: '上一张', exact: true }).click({ position: { x: 30, y: height / 2 } })
        assert.equal(await page.evaluate(() => window.lastPreviewIndex), -1)
        // An unloaded neighbour must not slide an empty image into the bounded window.
        await drag(30, height / 2, 75, 0, false)
        assert.equal(await dialog.locator('[data-image-preview-part="slide"]').evaluate(el => el.style.transform), 'translate3d(0px, 0px, 0px)')
        assert.equal(await dialog.locator('[data-image-preview-part="adjacent"]').count(), 0)
        await snapshot('-boundary')
        await page.mouse.up()
        assert.equal(await page.evaluate(() => window.lastPreviewIndex), -1)
      } else {
        // Drag from the edge hit zone: animation geometry must use the full stage width.
        await drag(width - 30, height / 2, -75, 0, false)
        assert.equal(await dialog.locator('[data-image-preview-part="slide"]').evaluate(el => el.style.transform), 'translate3d(-75px, 0px, 0px)')
        assert.equal(await dialog.locator('[data-image-preview-part="adjacent"]').evaluate(el => el.style.transform), `translate3d(${width - 75}px, 0px, 0px)`)
        await snapshot('-swiping')
        await page.mouse.up()
        await page.waitForFunction(() => window.lastPreviewIndex === 2)
        assert.equal(await dialog.getByRole('tab', { name: '图片 3', exact: true }).getAttribute('aria-selected'), 'true')
        await page.keyboard.press('+')
        await dialog.getByRole('button', { name: '关闭预览' }).focus()
        await page.keyboard.press('0')
        await dialog.getByRole('tab', { name: '图片 2', exact: true }).click()
        if (name === 'imagePreview') {
          const strip = dialog.getByRole('tablist', { name: '预览缩略图' })
          const box = await strip.boundingBox()
          await drag(box.x + box.width / 2, box.y + 35, -60, 0, false)
          assert.equal(await strip.evaluate(el => getComputedStyle(el).cursor), 'grabbing')
          await snapshot('-filmstrip-drag')
          await page.mouse.up()
          assert.equal(await dialog.getByRole('tab', { name: '图片 2', exact: true }).getAttribute('aria-selected'), 'true')
        } else {
          assert.equal(await dialog.getByRole('button', { name: '设为背景' }).isDisabled(), true)
          assert.equal(await dialog.getByRole('button', { name: '设为背景' }).getAttribute('title'), '没有本地图片，无法设为背景')
          await snapshot('-missing')
        }
      }
      await page.evaluate(() => window.setPreviewLoading(true))
      await dialog.getByText('正在读取下一页…', { exact: true }).waitFor()
      assert.equal(await dialog.getAttribute('aria-busy'), 'true')
      assert.equal(await dialog.getByRole('button', { name: '下一张', exact: true }).isDisabled(), true)
      assert.equal(await dialog.getByRole('tab').first().isDisabled(), true)
      await snapshot('-loading')
      await page.evaluate(() => window.setPreviewLoading(false))
      if (name === 'imagePreview') {
        await dialog.getByRole('button', { name: '背景 ✓' }).click()
        await dialog.getByRole('button', { name: '保存中…' }).waitFor()
        assert.equal(await page.evaluate(() => window.lastPreviewPoster.path), null)
        await snapshot('-saving')
        await page.evaluate(() => window.releasePreviewPoster())
        await dialog.waitFor({ state: 'detached' })
        assert.equal(await page.evaluate(() => document.body.style.overflow), '')
      } else {
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }

    if (name.startsWith('delete')) {
      const label = name === 'deleteDirector' ? '删除导演' : name === 'deleteOrganization' ? '完整删除机构' : name.startsWith('deleteRole') ? '移除制作商角色' : '删除系列'
      const dialog = page.getByRole('dialog', { name: label, exact: true })
      await dialog.waitFor()
      const confirm = dialog.getByRole('button', { name: label, exact: true })
      const snapshot = async suffix => {
        await page.waitForTimeout(180)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        const box = await dialog.boundingBox()
        assert.ok(box.y >= 0 && box.y + box.height <= height + 1)
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), caret: 'hide' })
      }
      if (name === 'deleteImpactLoading') {
        await dialog.getByText('正在检查影响范围…').waitFor()
        assert.equal(await confirm.isDisabled(), true)
        await snapshot('')
        await page.evaluate(() => window.releaseDeleteImpact())
      }
      if (name === 'deleteImpactError') {
        await dialog.getByText('影响范围读取失败：/fixture/分类资料/请稍后重试。', { exact: true }).waitFor()
        assert.equal(await confirm.isDisabled(), true)
        await snapshot('')
      } else if (name === 'deleteRoleBlocked') {
        await dialog.getByText(/这是该机构的最后一个角色/).waitFor()
        assert.equal(await confirm.isDisabled(), true)
        await snapshot('')
      } else {
        await confirm.isEnabled().then(async () => { await page.waitForFunction(() => document.querySelector('[data-ui="button"][disabled]') == null) })
        await dialog.getByText(/确定/).waitFor()
        assert.equal(await confirm.isEnabled(), true)
        await snapshot(name === 'deleteImpactLoading' ? '-loaded' : '')
        await confirm.click()
        await dialog.getByText('删除失败：资料修订已变化，请重新检查影响范围。', { exact: true }).waitFor()
        assert.equal(await confirm.isEnabled(), true)
        assert.equal(await page.evaluate(() => window.lastDeleteImpact.id), 7)
        await snapshot('-error')
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'galleryPaging' || name === 'avatarGalleryPaging') {
      const avatar = name === 'avatarGalleryPaging'
      if (avatar) await page.getByRole('tab', { name: '写真', exact: true }).click()
      const nav = page.getByRole('navigation', { name: avatar ? '头像写真分页' : '演员写真分页' })
      const snapshot = async suffix => {
        await nav.scrollIntoViewIfNeeded()
        await page.waitForTimeout(180)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        assert.equal(await nav.evaluate(el => getComputedStyle(el).display), 'flex')
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), caret: 'hide' })
      }
      await nav.waitFor()
      assert.equal(await nav.getByRole('button', { name: '上一页' }).isDisabled(), true)
      assert.equal(await nav.getByRole('button', { name: '下一页' }).isEnabled(), true)
      await snapshot('')
      await nav.getByRole('button', { name: '下一页' }).click()
      await page.waitForFunction(() => window.lastGalleryQuery.offset === 60)
      await nav.getByText(avatar ? '第 2 页' : '第 2 页 · 共 121 张', { exact: true }).waitFor()
      await snapshot('-second')
      await nav.getByRole('button', { name: '下一页' }).click()
      await page.waitForFunction(() => window.lastGalleryQuery.offset === 120)
      await nav.getByText(avatar ? '第 3 页' : '第 3 页 · 共 121 张', { exact: true }).waitFor()
      assert.equal(await nav.getByRole('button', { name: '下一页' }).isDisabled(), true)
      await snapshot('-last')
      await nav.getByRole('button', { name: '上一页' }).click()
      await page.waitForFunction(() => window.lastGalleryQuery.offset === 60)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name.startsWith('classificationMerge') || name === 'directorChoice' || name.startsWith('actressMerge')) {
      const dialog = page.getByRole('dialog', { name: name.startsWith('classificationMerge') ? '合并导演' : name === 'directorChoice' ? '选择导演' : '合并演员', exact: true })
      await dialog.waitFor()
      const snapshot = async suffix => {
        await page.waitForTimeout(180)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        const bounds = await dialog.boundingBox()
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height + 1)
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), caret: 'hide' })
      }
      if (name === 'directorChoice') {
        const confirm = dialog.getByRole('button', { name: '应用所选导演' })
        const rows = dialog.getByRole('radio')
        await rows.first().waitFor()
        assert.equal(await confirm.isDisabled(), true)
        await snapshot('')
        await rows.last().focus()
        await page.keyboard.press('Space')
        assert.equal(await rows.last().getAttribute('aria-checked'), 'true')
        assert.equal(await confirm.isEnabled(), true)
        await snapshot('-selected')
        await confirm.click()
        assert.equal(await page.evaluate(() => window.lastDirectorChoice), 29)
        assert.equal(await rows.first().isDisabled(), true)
        await snapshot('-busy')
      } else if (name.endsWith('Empty') || name.endsWith('Error')) {
        await dialog.getByText(name === 'classificationMergeEmpty' ? '没有可合并的导演' : name === 'classificationMergeError' ? '候选导演加载失败' : name === 'actressMergeEmpty' ? '没有可合并的候选演员' : '合并候选读取失败', { exact: true }).waitFor()
        assert.equal(await dialog.getByRole('button', { name: '确认合并', exact: true }).isDisabled(), true)
        await snapshot('')
      } else {
        const rows = dialog.getByRole('option')
        await rows.first().waitFor()
        const confirm = dialog.getByRole('button', { name: '确认合并', exact: true })
        assert.equal(await confirm.isDisabled(), true)
        await snapshot('')
        await rows.first().click()
        assert.equal(await rows.first().getAttribute('aria-selected'), 'true')
        assert.equal(await confirm.isEnabled(), true)
        if (name === 'actressMerge') await dialog.getByText('使用对方主名', { exact: true }).click()
        await snapshot('-selected')
        await confirm.click()
        await dialog.getByText(name === 'actressMerge' ? '合并失败：测试长路径 /fixture/actors/候选演员/资料暂时不可用，请重试。' : '合并失败：目标资料暂时不可用，请重试。', { exact: true }).waitFor()
        assert.equal(await confirm.isEnabled(), true)
        if (name === 'classificationMerge') assert.deepEqual(await page.evaluate(() => window.lastClassificationMerge), { targetId: 1, sourceId: 2 })
        else assert.deepEqual(await page.evaluate(() => window.lastActressMerge.input), { keepId: 1, mergeId: 2, mainNameFrom: 'merge' })
        await snapshot('-error')
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'conflictMerge' || name === 'conflictMergeBlocked') {
      const dialog = page.getByRole('dialog', { name: '合并演员档案' })
      await dialog.waitFor()
      const confirm = dialog.getByRole('button', { name: '确认合并', exact: true })
      assert.equal(await confirm.isDisabled(), true)
      assert.equal(await dialog.getByRole('checkbox').count(), 2)
      const keeper = dialog.locator('input[name="conflict-merge-keeper"]').first()
      assert.equal(await keeper.isDisabled(), name === 'conflictMergeBlocked')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      if (name === 'conflictMerge') {
        await keeper.check()
        await dialog.locator('input[name="conflict-merge-main-name"]').last().check()
        assert.equal(await confirm.isEnabled(), true)
        await page.waitForTimeout(180)
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-selected.png`) })
        await confirm.click()
        assert.deepEqual(await page.evaluate(() => window.lastConflictMerge), {
          keepActressId: 1, keepActressRevision: 2, mergeActressId: 2, mergeActressRevision: 3, finalMainName: '测试演员乙'
        })
        assert.equal(await dialog.getByRole('checkbox').first().isDisabled(), true)
      } else {
        await dialog.getByText('两位演员都有待确认刮削结果，请先处理其中一份。').waitFor()
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'actressConflict') {
      const host = page.locator('[data-actress-conflict-host]')
      await host.getByRole('heading', { name: '共享名称 · 确认名称归属' }).waitFor()
      const snapshot = async suffix => {
        await page.waitForTimeout(180)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`) })
      }
      await snapshot('')
      await host.getByRole('radio').first().check()
      await host.getByText('拟定归属：测试演员甲', { exact: true }).waitFor()
      await snapshot('-owner')
      await host.getByRole('tab', { name: '来源详情' }).click()
      await host.getByText('待确认刮削结果 · 测试插件', { exact: true }).waitFor()
      await snapshot('-source')
      await host.getByRole('tab', { name: '处理', exact: true }).click()
      await host.getByRole('button', { name: /测试演员乙.*历史声明/ }).click()
      await host.getByRole('tab', { name: '来源详情' }).click()
      await host.getByRole('heading', { name: '历史名称声明' }).waitFor()
      await snapshot('-claim')
      await host.getByRole('tab', { name: '处理', exact: true }).click()
      await host.getByRole('button', { name: '选择其他演员… 从演员库搜索组外演员' }).click()
      const picker = page.getByRole('dialog', { name: '选择其他演员' })
      const candidate = picker.getByRole('button', { name: /选择为拟定归属/ }).first()
      await candidate.waitFor()
      assert.equal(await candidate.evaluate(el => getComputedStyle(el).display), 'flex', 'owner candidates retain their card layout inside virtual cells')
      await picker.waitFor()
      await picker.getByRole('button', { name: '其他演员3 选择为拟定归属' }).waitFor()
      await snapshot('-picker')
      await picker.getByRole('searchbox').focus()
      await snapshot('-picker-focus')
      await picker.getByRole('button', { name: '其他演员3 选择为拟定归属' }).click()
      await picker.waitFor({ state: 'detached' })
      await host.getByText('拟定归属：其他演员3', { exact: true }).waitFor()
      await snapshot('-other')
      await host.getByRole('button', { name: '更多处理' }).click()
      await page.getByRole('button', { name: '修改返回名称' }).click()
      const edit = page.getByRole('dialog', { name: '修改本条返回名称' })
      await edit.waitFor()
      await edit.getByRole('textbox', { name: '新名称' }).fill('修改后的名称')
      await snapshot('-edit')
      await edit.getByRole('button', { name: '取消', exact: true }).click()
      await host.getByRole('button', { name: '更多处理' }).click()
      await page.getByRole('button', { name: '这不是演员名称' }).click()
      const replacement = page.getByRole('dialog', { name: '从本组删除「共享名称」' })
      await replacement.waitFor()
      const invalid = replacement.getByRole('textbox')
      await invalid.focus()
      assert.equal(await invalid.getAttribute('aria-invalid'), 'true')
      await snapshot('-replacement')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'detailActions') {
      const floating = page.getByRole('toolbar', { name: '影片操作' })
      const inline = page.getByRole('toolbar', { name: '演员操作' })
      await floating.waitFor()
      assert.equal(await floating.evaluate(el => getComputedStyle(el).position), width <= 768 ? 'static' : 'sticky')
      assert.equal(await inline.evaluate(el => getComputedStyle(el).position), 'static')
      assert.ok(await floating.getByRole('button', { name: '播放' }).isVisible())
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await floating.getByRole('button', { name: '更多' }).click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      assert.ok(await menu.getByRole('menuitem', { name: '删除影片' }).isVisible())
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-menu.png`) })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      await page.locator('[data-detail-actions-host]').evaluate(el => window.applyFixtureBackground(el))
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-background.png`) })
      const edit = floating.getByRole('button', { name: '编辑', exact: true })
      await edit.click()
      assert.equal(await edit.getAttribute('aria-busy'), 'true')
      assert.equal(await edit.isDisabled(), true)
      const animation = await edit.locator(':scope > span').evaluate(el => getComputedStyle(el).animationName)
      assert.notEqual(animation, 'spin', 'Busy animation must not depend on the global keyframe')
      assert.notEqual(animation, 'none')
      await page.waitForTimeout(200)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-busy.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'videoMeta') {
      const primary = page.locator('[data-primary-meta]')
      const maintenance = page.locator('[data-maintenance-meta]')
      await primary.waitFor()
      assert.equal(await primary.evaluate(el => getComputedStyle(el).display), 'grid')
      assert.equal(await primary.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), width <= 480 ? 1 : 2)
      assert.equal(await maintenance.locator(':scope > div').count(), 4)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      const link = page.getByRole('button', { name: '演示制作商' })
      await link.hover()
      assert.equal(await link.evaluate(el => getComputedStyle(el).textDecorationLine), 'underline')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-hover.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'videoResources') {
      const rows = page.locator('[data-video-resources-host] [data-resource-row]')
      await rows.first().waitFor()
      assert.equal(await rows.count(), 2)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await rows.nth(1).getByRole('button', { name: '更多' }).click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      assert.ok(await menu.getByRole('menuitem', { name: '查看完整链接' }).isVisible())
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-menu.png`) })
      await menu.getByRole('menuitem', { name: '查看完整链接' }).click()
      await page.getByText('https://example.com/full/ABP-123?token=example').waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-full.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'videoTitle') {
      const title = page.getByRole('heading', { level: 1 })
      await title.waitFor()
      const hintLink = page.locator('[data-scrape-hint-link]')
      const pendingBadge = page.getByRole('button', { name: '查看待确认候选' })
      assert.equal(await pendingBadge.evaluate(el => getComputedStyle(el).cursor), 'pointer')
      assert.equal(await hintLink.evaluate(el => getComputedStyle(el).marginLeft), '4px')
      assert.equal(await hintLink.evaluate(el => getComputedStyle(el).marginRight), '4px')
      assert.equal(await hintLink.evaluate(el => getComputedStyle(el).fontSize), '11px')
      const cover = page.locator('[data-video-cover]')
      const heroBody = page.locator('[data-hero-body]')
      await cover.locator('img').evaluate(img => img.decode())
      assert.equal(await heroBody.evaluate(el => getComputedStyle(el).display), 'grid')
      assert.ok(Math.abs((await cover.boundingBox()).width - (width <= 768 ? width - 48 : 420)) < 1)
      assert.equal(await cover.evaluate(el => getComputedStyle(el).cursor), 'zoom-in')
      assert.equal(await title.evaluate(el => getComputedStyle(el).webkitLineClamp), '2')
      const fontSize = parseFloat(await title.evaluate(el => getComputedStyle(el).fontSize))
      const containerWidth = width - 48
      const expectedSize = containerWidth <= 720 ? 18 : containerWidth <= 900 ? 20 : Math.min(24, Math.max(19, containerWidth * 0.022))
      assert.ok(Math.abs(fontSize - expectedSize) < 0.1, `${width}: ${fontSize} != ${expectedSize}`)
      assert.equal(await title.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--text-primary)'
        document.body.append(probe)
        const matches = getComputedStyle(el).color === getComputedStyle(probe).color
        probe.remove()
        return matches
      }), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await cover.hover()
      await page.waitForFunction(() => {
        const cover = document.querySelector('[data-video-cover]')
        const probe = document.createElement('span')
        probe.style.borderColor = 'var(--border-accent)'
        document.body.append(probe)
        const matches = getComputedStyle(cover).borderTopColor === getComputedStyle(probe).borderTopColor
        probe.remove()
        return matches
      })
      await page.getByRole('button', { name: '切换竖版封面' }).click()
      await cover.locator('img').evaluate(img => img.decode())
      await page.mouse.move(0, 0)
      assert.ok(await cover.locator('img').evaluate(el => el.naturalHeight > el.naturalWidth))
      assert.ok(Math.abs((await cover.boundingBox()).width - (width <= 768 ? width - 48 : 420)) < 1)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-tall.png`) })
      await page.evaluate(() => {
        document.documentElement.dataset.privacyMode = 'true'
        document.documentElement.dataset.privacyCovers = 'true'
      })
      assert.notEqual(await cover.locator('img').evaluate(el => getComputedStyle(el).filter), 'none')
      assert.equal(await cover.evaluate(el => getComputedStyle(el, '::after').content), '""')
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-privacy.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'actressHeader') {
      const header = page.locator('[data-actress-header]')
      await header.waitFor()
      assert.equal(await header.evaluate(el => getComputedStyle(el).display), 'grid')
      assert.equal((await header.locator('[aria-label="查看原图：示例演员"]').boundingBox()).width, 160)
      assert.equal(await page.getByRole('heading', { name: '示例演员' }).evaluate(el => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--text-primary)'
        document.body.append(probe)
        const matches = getComputedStyle(el).color === getComputedStyle(probe).color
        probe.remove()
        return matches
      }), true)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.getByRole('tab', { name: '写真', exact: true }).click()
      assert.equal(await page.getByRole('tab', { name: '写真', exact: true }).getAttribute('aria-selected'), 'true')
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-gallery.png`) })
      await page.locator('[data-actress-header-host]').evaluate(el => window.applyFixtureBackground(el))
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-background.png`) })
      const avatarFrame = page.getByRole('button', { name: '查看原图：示例演员' })
      assert.equal(await avatarFrame.evaluate(el => getComputedStyle(el).cursor), 'zoom-in')
      await avatarFrame.hover()
      await page.waitForFunction(() => {
        const avatar = document.querySelector('[data-actress-header] [data-size="detail"]')
        const probe = document.createElement('span')
        probe.style.borderColor = 'var(--border-accent)'
        document.body.append(probe)
        const matches = getComputedStyle(avatar).borderTopColor === getComputedStyle(probe).borderTopColor
        probe.remove()
        return matches
      })
      assert.equal(await avatarFrame.locator('[data-size="detail"]').evaluate(el => {
        const probe = document.createElement('span')
        probe.style.borderColor = 'var(--border-accent)'
        document.body.append(probe)
        const matches = getComputedStyle(el).borderTopColor === getComputedStyle(probe).borderTopColor
        probe.remove()
        return matches
      }), true)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'actressProfileMeta') {
      const cards = page.locator('[data-actress-meta-card]')
      await cards.first().waitFor()
      assert.equal(await cards.count(), 5)
      assert.notEqual(await cards.first().evaluate(el => getComputedStyle(el).backgroundImage), 'none')
      const normalBorder = await cards.first().evaluate(el => getComputedStyle(el).borderTopColor)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.locator('[data-actress-meta-host]').evaluate(el => window.applyFixtureBackground(el))
      assert.notEqual(await cards.first().evaluate(el => getComputedStyle(el).borderTopColor), normalBorder)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-background.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'galleryTiles') {
      const tiles = page.locator('[data-media-tile]')
      await tiles.nth(1).waitFor()
      assert.equal(await tiles.count(), 2)
      await page.locator('[data-gallery-host] img').first().evaluate(img => img.decode())
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.evaluate(() => {
        document.documentElement.dataset.privacyMode = 'true'
        document.documentElement.dataset.privacyVideoSamples = 'true'
      })
      assert.notEqual(await tiles.first().locator('img').evaluate(img => getComputedStyle(img).filter), 'none')
      assert.equal(await tiles.nth(1).locator('img').evaluate(img => getComputedStyle(img).filter), 'none')
      await page.evaluate(() => {
        document.documentElement.dataset.privacyActressGallery = 'true'
      })
      for (const tile of await tiles.all()) {
        assert.notEqual(await tile.locator('img').evaluate(img => getComputedStyle(img).filter), 'none')
        assert.equal(await tile.locator('button').first().evaluate(button => getComputedStyle(button, '::after').content), '""')
      }
      // CSS filter/scale may be computed before Chromium has painted the privacy blur.
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-privacy.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'listDetailShell') {
      const base = page.locator('[data-list-shell-base]')
      const overlay = page.locator('[data-list-detail-overlay]')
      await overlay.waitFor()
      assert.equal(await base.evaluate(el => getComputedStyle(el.parentElement).opacity), '0')
      assert.equal(await base.evaluate(el => getComputedStyle(el.parentElement).pointerEvents), 'none')
      assert.equal(await overlay.evaluate(el => getComputedStyle(el).position), 'absolute')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.locator('[data-list-shell-host]').evaluate(el => window.applyFixtureBackground(el))
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-list-detail-overlay]')).backgroundColor === 'rgba(0, 0, 0, 0)')
      assert.notEqual(await overlay.evaluate(el => getComputedStyle(el).boxShadow), 'none')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-background.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'detailScroll') {
      const content = page.locator('[data-page-content]')
      await page.getByText('详情空状态', { exact: true }).waitFor()
      assert.equal(await content.evaluate(el => getComputedStyle(el).paddingLeft), width <= 960 ? '20px' : '32px')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.locator('[data-scroll-host]').evaluate(el => window.applyFixtureBackground(el))
      assert.notEqual(await content.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-background.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'detailPane') {
      const base = page.locator('[data-pane-base]')
      const overlay = page.locator('[data-detail-pane-overlay]')
      await overlay.waitFor()
      assert.equal(await base.evaluate(el => getComputedStyle(el).opacity), '0')
      assert.equal(await base.evaluate(el => getComputedStyle(el).pointerEvents), 'none')
      assert.equal(await overlay.evaluate(el => getComputedStyle(el).position), 'absolute')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.locator('[data-pane-host]').evaluate(el => window.applyFixtureBackground(el))
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-detail-pane-overlay]')).backgroundColor === 'rgba(0, 0, 0, 0)')
      assert.equal(await overlay.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
      assert.notEqual(await overlay.evaluate(el => getComputedStyle(el).boxShadow), 'none')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-background.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'detailTitles') {
      const title = page.getByRole('heading', { name: '演员标题' })
      await title.waitFor()
      assert.equal(await title.evaluate(el => getComputedStyle(el).fontSize), '14px')
      assert.equal(await title.evaluate(el => getComputedStyle(el).marginTop), '0px')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'detailSections') {
      const host = page.locator('[data-detail-sections-host]')
      const actress = host.getByRole('button', { name: /示例演员/ })
      await actress.waitFor()
      assert.equal(await actress.evaluate(el => getComputedStyle(el).width), '76px')
      assert.equal(await actress.locator('img, [role="img"]').first().evaluate(el => getComputedStyle(el).width), '64px')
      assert.equal(await host.getByText('这是一段可选择复制的影片剧情简介。第二行用于检查文字换行与行距。').evaluate(el => getComputedStyle(el).userSelect), 'text')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await actress.focus()
      await page.waitForTimeout(180)
      assert.equal(await actress.locator('[role="img"]').evaluate(el => {
        const probe = document.createElement('span')
        probe.style.borderColor = 'var(--border-accent)'
        document.body.append(probe)
        const matches = getComputedStyle(el).borderTopColor === getComputedStyle(probe).borderTopColor
        probe.remove()
        return matches
      }), true)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-focus.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'videoTags') {
      const host = page.locator('[data-video-tags-host]')
      await host.getByRole('button', { name: '添加自定义标签' }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      const manual = host.getByText('自定义标签', { exact: true })
      await manual.hover()
      await page.waitForTimeout(180)
      assert.equal(await host.getByRole('button', { name: '移除自定义标签 自定义标签' }).evaluate(el => getComputedStyle(el).opacity), '1')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-hover.png`) })
      await host.getByRole('button', { name: '添加自定义标签' }).click()
      const dialog = page.getByRole('dialog', { name: '添加自定义标签' })
      await dialog.waitFor()
      await dialog.getByRole('button', { name: /候选标签/ }).first().waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-modal.png`) })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'videoInfo') {
      const host = page.locator('[data-video-info-host]')
      await host.getByText('外部评分', { exact: true }).waitFor()
      assert.equal(await host.getByRole('button', { name: '3 星' }).evaluate(el => getComputedStyle(el).cursor), 'pointer')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await host.getByRole('button', { name: '隐藏外部评分' }).click()
      assert.equal(await host.getByText('外部评分', { exact: true }).count(), 0)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-local.png`) })
      await host.getByRole('link', { name: /官网资料/ }).click()
      assert.equal(await page.evaluate(() => window.lastOpenedLink), 'https://example.com/profile')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name.startsWith('classificationProfile')) {
      const host = page.locator('[data-classification-profile-host]')
      const image = host.locator('img').first()
      await image.waitFor()
      await image.evaluate(img => img.decode())
      assert.equal(await image.evaluate(img => getComputedStyle(img).objectFit), name === 'classificationProfileOrganization' ? 'contain' : 'cover')
      assert.equal(await host.getByRole('heading', { level: 1 }).evaluate(el => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--text-primary)'
        document.body.append(probe)
        const matches = getComputedStyle(el).color === getComputedStyle(probe).color
        probe.remove()
        return matches
      }), true)
      const frame = image.locator('..')
      const bounds = await frame.boundingBox()
      assert.ok(Math.abs(bounds.width / bounds.height - (name === 'classificationProfileDirector' ? 0.75 : 1.49)) < 0.02)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.evaluate(() => {
        document.documentElement.dataset.privacyMode = 'true'
        document.documentElement.dataset.privacyCovers = 'true'
      })
      assert.notEqual(await image.evaluate(img => getComputedStyle(img).filter), 'none')
      await page.waitForTimeout(250)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-privacy.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'classificationDetailLayout') {
      const host = page.locator('[data-classification-detail-layout-host]')
      const content = host.locator('[data-page-content]')
      await content.waitFor()
      assert.equal(await content.evaluate(el => getComputedStyle(el).display), 'flex')
      assert.equal(await content.evaluate(el => getComputedStyle(el).gap), '14px')
      assert.equal(await host.getByText('关联影片', { exact: true }).evaluate(el => getComputedStyle(el).paddingTop), '14px')
      const viewport = content.locator('..')
      assert.equal(await viewport.evaluate(el => el.scrollHeight > el.clientHeight), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      const colors = await host.evaluate(el => ({ theme: document.documentElement.dataset.theme,
        token: getComputedStyle(el).getPropertyValue('--text-primary').trim(),
        body: getComputedStyle(document.body).color,
        summary: getComputedStyle(el.querySelector('[data-classification-summary-card]')).color }))
      const rgb = colors.token.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
      assert.ok(rgb, 'fixture theme must expose a concrete semantic text color')
      const expectedColor = `rgb(${rgb.slice(1).map(value => parseInt(value, 16)).join(', ')})`
      assert.equal(colors.body, expectedColor, 'body must resolve the selected theme before capture')
      assert.equal(colors.summary, expectedColor, 'unadorned fixture text must inherit the selected theme')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await viewport.evaluate(el => { el.scrollTop = el.scrollHeight })
      assert.ok(await viewport.evaluate(el => el.scrollTop > 0))
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-scrolled.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, colors })
      await page.close()
      continue
    }
    if (name === 'entityEditForm') {
      const host = page.locator('[data-entity-edit-form-host]')
      const grids = host.locator('[data-edit-form-fields]')
      const checkRow = host.locator('[data-edit-form-check-row]')
      const suffix = host.locator('[data-entity-edit-input-suffix]')
      const inlineRow = host.locator('[data-entity-edit-inline-row]')
      const nameInput = host.getByRole('textbox', { name: '主名', exact: true })
      const summaryInput = host.getByRole('textbox', { name: '简介', exact: true })
      const ownerInput = host.getByRole('combobox', { name: '所属机构' })
      await nameInput.waitFor()
      assert.equal(await grids.count(), 2)
      assert.equal(await grids.first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), width <= 560 ? 1 : 2)
      assert.equal(await checkRow.evaluate(el => getComputedStyle(el).gridColumn), '1 / -1')
      assert.ok(await checkRow.evaluate(el => el.getBoundingClientRect().height >= 24))
      const suffixMetrics = await suffix.evaluate(el => {
        const input = el.querySelector('input')
        const unit = el.querySelector('span')
        const inputStyle = getComputedStyle(input), unitStyle = getComputedStyle(unit)
        return { width: el.getBoundingClientRect().width, inputWidth: input.getBoundingClientRect().width,
          inputPaddingRight: parseFloat(inputStyle.paddingRight), expectedPaddingRight: parseFloat(inputStyle.fontSize) * 2.4,
          unitRight: unitStyle.right, unitPosition: unitStyle.position }
      })
      assert.ok(Math.abs(suffixMetrics.width - suffixMetrics.inputWidth) < 1)
      assert.ok(Math.abs(suffixMetrics.inputPaddingRight - suffixMetrics.expectedPaddingRight) < 1)
      assert.equal(suffixMetrics.unitRight, '10px')
      assert.equal(suffixMetrics.unitPosition, 'absolute')
      assert.equal(await inlineRow.locator('input').count(), 3)
      assert.equal(await inlineRow.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 3)
      assert.equal(await inlineRow.evaluate(el => getComputedStyle(el).columnGap), '8px')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await suffix.screenshot({ path: path.join(output, `${name}-${width}-${theme}-suffix.png`) })
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await nameInput.focus()
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-focus.png`) })
      await nameInput.fill('改名后仍在原位')
      assert.equal(await nameInput.inputValue(), '改名后仍在原位')
      await checkRow.click()
      assert.equal(await checkRow.locator('input').isChecked(), false)
      const controlMetrics = await host.evaluate(el => {
        const measure = selector => {
          const input = el.querySelector(selector), style = getComputedStyle(input)
          return { width: input.getBoundingClientRect().width, parentWidth: input.parentElement.getBoundingClientRect().width,
            minHeight: style.minHeight, resize: style.resize, lineHeight: style.lineHeight }
        }
        return { name: measure('#entity-fixture-name'), summary: measure('#entity-fixture-summary'), owner: measure('#entity-fixture-owner') }
      })
      assert.ok(await summaryInput.isVisible())
      assert.ok(await ownerInput.isVisible())
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, checkRowGridColumn: await checkRow.evaluate(el => getComputedStyle(el).gridColumn), controlMetrics })
      await page.close()
      continue
    }
    if (name === 'entityMediaSection') {
      const host = page.locator('[data-entity-media-host]')
      const section = host.locator('section')
      const field = host.locator('input[type="file"]').locator('..')
      await field.waitFor()
      await page.waitForTimeout(250)
      const metrics = await section.evaluate(el => {
        const field = el.querySelector('input[type="file"]').parentElement, sectionStyle = getComputedStyle(el), fieldStyle = getComputedStyle(field)
        return { paddingTop: sectionStyle.paddingTop, paddingBottom: sectionStyle.paddingBottom,
          fieldWidth: field.getBoundingClientRect().width, sectionWidth: el.getBoundingClientRect().width,
          fieldAlignSelf: fieldStyle.alignSelf, fieldDirection: fieldStyle.flexDirection }
      })
      assert.equal(metrics.paddingTop, '10px')
      assert.equal(metrics.paddingBottom, '10px')
      assert.equal(metrics.fieldAlignSelf, 'stretch')
      assert.equal(metrics.fieldDirection, width <= 560 ? 'column' : 'row')
      assert.ok(Math.abs(metrics.fieldWidth - (metrics.sectionWidth - 22)) < 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      assert.ok(await host.getByRole('button', { name: '选择图片' }).isVisible())
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'imageImportField') {
      const host = page.locator('[data-image-import-host]')
      const wide = host.locator('[data-image-import-wide] input[type="file"]').locator('..')
      const square = host.locator('[data-image-import-square] input[type="file"]').locator('..')
      const stack = host.locator('[data-image-import-stack] input[type="file"]').locator('..')
      await stack.waitFor()
      const metrics = await host.evaluate(el => {
        const measure = selector => {
          const field = el.querySelector(`${selector} input[type="file"]`).parentElement
          const preview = field.firstElementChild, image = preview.querySelector('img'), style = getComputedStyle(field)
          return { direction: style.flexDirection, alignSelf: style.alignSelf,
            previewWidth: preview.getBoundingClientRect().width, previewHeight: preview.getBoundingClientRect().height,
            previewObjectFit: image ? getComputedStyle(image).objectFit : null }
        }
        return { wide: measure('[data-image-import-wide]'), square: measure('[data-image-import-square]'), stack: measure('[data-image-import-stack]') }
      })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      assert.ok(await wide.getByRole('button', { name: '移除当前封面' }).isVisible())
      assert.ok(await square.locator('img').isVisible())
      assert.ok(await stack.locator('img').isVisible())
      await wide.locator('input[type="file"]').setInputFiles({ name: 'cover.svg', mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="teal"/></svg>') })
      await wide.getByRole('button', { name: '取消选择' }).waitFor()
      assert.equal(await page.evaluate(() => window.lastImageImportPath), '/fixture-cover.svg')
      assert.ok(await wide.locator('img').isVisible())
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-selected.png`), fullPage: true })
      await wide.getByRole('button', { name: '取消选择' }).click()
      assert.ok(await wide.getByText('无封面').isVisible())
      assert.equal(await page.evaluate(() => window.lastImageImportPath), null)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'settingsWorkspaceShell') {
      const host = page.locator('[data-page-content]')
      await host.getByRole('region', { name: '版本更新' }).waitFor()
      const metrics = await host.evaluate(el => ({
        display: getComputedStyle(el).display,
        direction: getComputedStyle(el).flexDirection,
        gap: getComputedStyle(el).gap,
        paddingBottom: getComputedStyle(el).paddingBottom,
        minHeight: getComputedStyle(el).minHeight
      }))
      assert.equal(metrics.display, 'flex')
      assert.equal(metrics.direction, 'column')
      assert.equal(metrics.gap, '12px')
      assert.equal(metrics.paddingBottom, '0px')
      const activeLink = host.getByRole('link', { name: '概览' })
      assert.equal(await activeLink.getAttribute('data-active'), 'true')
      assert.notEqual(await activeLink.evaluate(el => getComputedStyle(el).borderColor), 'rgba(0, 0, 0, 0)')
      assert.equal(await host.getByRole('link', { name: '媒体库' }).getAttribute('data-active'), 'false')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      await host.getByRole('link', { name: '媒体库' }).click()
      assert.deepEqual(await page.evaluate(() => window.lastWorkspaceNavigation), ['library'])
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'appUpdate' || name === 'appUpdateIgnored') {
      const panel = page.getByRole('region', { name: '版本更新' })
      const ignored = name === 'appUpdateIgnored'
      await panel.getByText(ignored ? '版本 0.8.1 已暂不提醒' : '发现新版本 0.8.1').waitFor()
      const metrics = await panel.evaluate(el => ({
        display: getComputedStyle(el).display,
        borderWidth: getComputedStyle(el).borderWidth,
        padding: getComputedStyle(el).padding,
        headingMargin: getComputedStyle(el.querySelector('h3')).margin,
        width: el.getBoundingClientRect().width
      }))
      assert.equal(metrics.display, 'grid')
      assert.equal(metrics.borderWidth, '1px')
      assert.equal(await panel.getByText('Javdex 0.8.1').evaluate(el => getComputedStyle(el).color),
        await panel.getByRole('heading', { name: '版本更新' }).evaluate(el => getComputedStyle(el).color))
      if (ignored) {
        assert.equal(await panel.getByRole('button', { name: '暂不提醒' }).count(), 0)
        await panel.getByText('查看更新说明').click()
        assert.ok(await panel.getByRole('heading', { name: '更新内容' }).isVisible())
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      await panel.getByRole('button', { name: '检查更新' }).click()
      await panel.getByText('当前已是最新版本').waitFor()
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'pluginConnectionNotice' || name === 'actressDeleteNotice') {
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      const warning = dialog.getByRole(name === 'pluginConnectionNotice' ? 'alert' : 'status')
      await warning.waitFor()
      const metrics = await warning.evaluate(el => ({
        display: getComputedStyle(el).display,
        borderLeftWidth: getComputedStyle(el).borderLeftWidth,
        background: getComputedStyle(el).backgroundColor,
        width: el.getBoundingClientRect().width
      }))
      assert.equal(metrics.display, 'flex')
      assert.equal(metrics.borderLeftWidth, '3px')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'settingsOverview' || name === 'settingsOverviewEmpty' || name === 'settingsOverviewNotices') {
      const host = page.locator('[data-settings-overview-host]')
      const grid = host.locator('[data-settings-media-grid]')
      const video = host.getByRole('region', { name: '影片刮削概览' })
      const actress = host.getByRole('region', { name: '演员刮削概览' })
      await grid.waitFor()
      if (name === 'settingsOverviewEmpty') {
        await video.getByText('添加路径并扫描后开始积累影片').waitFor()
        assert.ok(await actress.getByText('导入影片后会自动建立演员条目').isVisible())
      } else {
        await video.getByRole('img', { name: /已刮削 60%/ }).waitFor()
        assert.ok(await actress.getByRole('img', { name: /已刮削 57%/ }).isVisible())
      }
      const metrics = await grid.evaluate(el => ({ columns: getComputedStyle(el).gridTemplateColumns,
        videoCardDisplay: getComputedStyle(el.firstElementChild).display,
        cardWidth: el.firstElementChild.getBoundingClientRect().width }))
      assert.equal(metrics.videoCardDisplay, 'flex')
      assert.ok(metrics.cardWidth > 200)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      if (name === 'settingsOverviewNotices') {
        await host.getByRole('button', { name: '查看媒体库' }).click()
        assert.equal(await page.evaluate(() => window.lastNoticeAction), 'library')
        await host.getByRole('button', { name: '查看设置' }).click()
        assert.equal(await page.evaluate(() => window.lastNoticeAction), 'network')
      }
      if (name === 'settingsOverviewEmpty') {
        await video.getByRole('button', { name: '高级刮削' }).click()
        assert.deepEqual(await page.evaluate(() => window.lastSettingsOverviewAction), ['videoAdvanced'])
      } else {
        await video.getByRole('button', { name: '刮削未刮削项' }).click()
        assert.deepEqual(await page.evaluate(() => window.lastSettingsOverviewAction), ['videoDefault'])
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'batchOverview') {
      const host = page.locator('[data-batch-overview-host]')
      const idle = host.locator('[data-batch-idle]')
      const running = host.locator('[data-batch-running]')
      const paused = host.locator('[data-batch-paused]')
      await idle.getByRole('img', { name: '批量任务空闲' }).waitFor()
      assert.ok(await running.getByRole('img', { name: /进度 35%/ }).isVisible())
      assert.ok(await paused.getByRole('img', { name: /进度 70%/ }).isVisible())
      assert.ok(await paused.getByText('不可恢复').isVisible())
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      await idle.getByRole('button', { name: '查看待确认' }).click()
      assert.equal(await page.evaluate(() => window.lastBatchOverview), 'pending')
      await running.getByRole('button', { name: '查看影片批量任务详情' }).click()
      assert.equal(await page.evaluate(() => window.lastBatchOverview), 'running')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'settingsStatusCards') {
      const host = page.locator('[data-settings-status-host]')
      const grid = host.locator('[data-settings-status-grid]')
      const cards = host.getByRole('button')
      await grid.waitFor()
      assert.equal(await cards.count(), 4)
      const metrics = await grid.evaluate(el => ({ columns: getComputedStyle(el).gridTemplateColumns,
        firstCardWidth: el.firstElementChild.getBoundingClientRect().width }))
      assert.ok(metrics.firstCardWidth >= 118)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      const scraper = host.getByRole('button', { name: /影片刮削/ })
      await scraper.hover()
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-hover.png`), fullPage: true })
      await scraper.click()
      assert.equal(await page.evaluate(() => window.lastStatusCard), 'scraper')
      await page.keyboard.press('Tab')
      const network = host.getByRole('button', { name: /局域网访问/ })
      assert.equal(await network.evaluate(el => el === document.activeElement), true)
      assert.notEqual(await network.evaluate(el => getComputedStyle(el).boxShadow), 'none')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'scrapeCoverage') {
      const host = page.locator('[data-scrape-coverage-host]')
      const failed = host.locator('[data-scrape-coverage-failed]')
      const clean = host.locator('[data-scrape-coverage-clean]')
      await failed.getByRole('img', { name: '已刮削 71%，未刮削 22%，失败 7%' }).waitFor()
      assert.ok(await clean.getByRole('img', { name: '已刮削 72%，未刮削 28%' }).isVisible())
      const metrics = await failed.evaluate(el => {
        const block = el.firstElementChild, bar = block.lastElementChild, head = block.firstElementChild
        return { marginTop: getComputedStyle(block).marginTop, barHeight: bar.getBoundingClientRect().height,
          fontSize: getComputedStyle(head).fontSize, lineHeight: getComputedStyle(head).lineHeight }
      })
      assert.equal(metrics.marginTop, '0px')
      assert.equal(metrics.barHeight, 8)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'pluginConfigBuiltin' || name === 'pluginConfigUser') {
      const dialog = page.getByRole('dialog', { name: name === 'pluginConfigBuiltin' ? '编辑插件：MetaTube' : '编辑插件：Fixture User' })
      await dialog.waitFor()
      const metrics = await dialog.evaluate(el => {
        const rect = el.getBoundingClientRect()
        const body = el.querySelector('[data-modal-part="body"]')
        return { width: rect.width, right: rect.right, height: rect.height,
          bodyOverflowY: body ? getComputedStyle(body).overflowY : null }
      })
      assert.ok(metrics.right <= width + 1)
      assert.ok(metrics.height <= height + 1)
      assert.ok(await dialog.getByRole('heading', { name: '基本信息' }).isVisible())
      assert.ok(await dialog.getByRole('heading', { name: '支持字段' }).count())
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      if (name === 'pluginConfigBuiltin') {
        await dialog.getByRole('button', { name: '测试连接' }).click()
        await dialog.getByText('连接成功 · 1.4.0 · DB 42 · 3 个影片源').waitFor()
      } else {
        const switchControl = dialog.getByRole('switch', { name: '刮削前预登入' })
        await switchControl.uncheck()
        assert.equal(await switchControl.isChecked(), false)
      }
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-changed.png`), fullPage: true })
      await dialog.getByRole('heading', { name: '支持字段' }).scrollIntoViewIfNeeded()
      assert.ok(await dialog.getByRole('list', { name: '支持字段' }).getByRole('listitem').count() > 0)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-fields.png`), fullPage: true })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'pluginsSettingsEmpty' || name === 'pluginsSettingsCards') {
      const host = page.locator('[data-plugins-settings-host]')
      const toolbar = host.getByRole('search')
      await toolbar.waitFor()
      const metrics = await host.evaluate(el => {
        const card = el.firstElementChild
        const toolbar = card.querySelector('[role="search"]')
        const list = card.querySelector('[role="list"]')
        return { cardDisplay: getComputedStyle(card).display, cardGap: getComputedStyle(card).gap,
          toolbarColumns: getComputedStyle(toolbar).gridTemplateColumns,
          toolbarPadding: getComputedStyle(toolbar).padding,
          gridColumns: list ? getComputedStyle(list).gridTemplateColumns : null }
      })
      assert.equal(metrics.cardDisplay, 'flex')
      if (name === 'pluginsSettingsEmpty') {
        assert.ok(await host.getByText('暂无影片插件，可导入或使用开发助手创建').isVisible())
      } else {
        assert.equal(await host.getByRole('listitem').count(), 3)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      if (name === 'pluginsSettingsEmpty') {
        await host.getByRole('button', { name: '导入插件' }).last().click()
        assert.equal(await page.evaluate(() => window.lastPluginsSettingsAction), 'import')
      } else {
        const userCard = host.getByRole('listitem').nth(1)
        await userCard.hover()
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-hover.png`), fullPage: true })
        await userCard.getByRole('button', { name: '更多操作' }).click()
        const menu = page.getByRole('menu')
        await menu.waitFor()
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-menu.png`), fullPage: true })
        await menu.getByRole('menuitem', { name: '导出' }).click()
        assert.equal(await page.evaluate(() => window.lastPluginsSettingsAction), 'export')
        await toolbar.getByPlaceholder('插件名、站点、字段').fill('Fixture User')
        assert.equal(await host.getByRole('listitem').count(), 1)
        await toolbar.getByRole('button', { name: '清空' }).click()
        assert.equal(await host.getByRole('listitem').count(), 3)
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'settingsLoading') {
      const host = page.locator('[data-settings-loading-host]')
      const label = host.getByText('加载设置…', { exact: true })
      await label.waitFor()
      assert.equal(await label.evaluate(el => getComputedStyle(el).fontSize), '12px')
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'settingsEmptyVariants') {
      const host = page.locator('[data-settings-empty-host]')
      await host.getByText('尚未安装插件').waitFor()
      const metrics = await host.evaluate(el => {
        const names = ['plain', 'dashed', 'compact', 'source', 'plugin', 'batch']
        return Object.fromEntries(names.map(name => {
          const root = el.querySelector(`[data-settings-empty-${name}]`)?.firstElementChild
          const style = getComputedStyle(root)
          const description = root.querySelector('[data-empty-part="description"]')
          const descriptionStyle = getComputedStyle(description)
          return [name, { height: root.getBoundingClientRect().height, minHeight: style.minHeight,
            padding: style.padding, borderStyle: style.borderStyle, borderColor: style.borderColor,
            borderRadius: style.borderRadius, backgroundColor: style.backgroundColor,
            color: style.color, fontSize: style.fontSize, lineHeight: style.lineHeight,
            textAlign: style.textAlign, display: style.display, alignItems: style.alignItems,
            justifyContent: style.justifyContent, gap: style.gap, flex: style.flex,
            description: { width: descriptionStyle.width, maxWidth: descriptionStyle.maxWidth,
              display: descriptionStyle.display, flexDirection: descriptionStyle.flexDirection,
              alignItems: descriptionStyle.alignItems, gap: descriptionStyle.gap } }]
        }))
      })
      assert.equal(Object.keys(metrics).length, 6)
      assert.ok(metrics.batch.height > 100)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      await host.getByRole('button', { name: '导入插件' }).click()
      assert.equal(await page.evaluate(() => window.lastSettingsEmptyAction), 'import')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'batchSettingsEmpty' || name === 'batchSettingsRunning' || name === 'batchSettingsPaused') {
      const dialog = page.getByRole('dialog', { name: '批量更新（影片）' })
      const log = dialog.getByRole('region', { name: '影片任务日志' })
      await log.waitFor()
      const card = log.locator('..')
      const metrics = await card.evaluate(el => ({
        display: getComputedStyle(el).display,
        height: el.getBoundingClientRect().height,
        padding: getComputedStyle(el).padding,
        overflow: getComputedStyle(el).overflow
      }))
      assert.equal(metrics.display, 'flex')
      assert.equal(metrics.overflow, 'hidden')
      assert.ok(metrics.height > 200)
      if (name === 'batchSettingsEmpty') {
        assert.ok(await log.getByText('暂无任务日志').isVisible())
      } else {
        assert.ok(await log.getByText(/已更新资料/).isVisible())
        assert.equal(await dialog.getByRole('progressbar').getAttribute('aria-valuenow'), '37')
      }
      if (name === 'batchSettingsPaused') {
        assert.ok(await dialog.getByText('不可恢复').isVisible())
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      await dialog.getByRole('button', { name: '查看待确认' }).click()
      assert.equal(await page.evaluate(() => window.lastBatchSettingsAction), 'pending')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'batchTaskControls') {
      const host = page.locator('[data-batch-controls-host]')
      const buttonGroup = host.getByRole('group', { name: '影片批量任务控制' })
      const iconGroup = host.getByRole('group', { name: '演员批量任务控制' })
      await buttonGroup.waitFor()
      assert.ok(await iconGroup.isVisible())
      assert.equal(await buttonGroup.getByRole('button').count(), 3)
      assert.equal(await iconGroup.getByRole('button').count(), 2)
      assert.ok(await host.getByRole('button', { name: '查看批量任务详情' }).isVisible())
      assert.equal(await buttonGroup.getByRole('button', { name: '暂停' }).isEnabled(), true)
      assert.equal(await buttonGroup.getByRole('button', { name: '继续' }).isDisabled(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      await buttonGroup.getByRole('button', { name: '暂停' }).click()
      assert.equal(await buttonGroup.locator('[aria-busy="true"]').count(), 1)
      assert.equal(await buttonGroup.getByRole('button', { name: '终止' }).isDisabled(), true)
      await iconGroup.getByRole('button', { name: '继续演员批量任务' }).click()
      assert.equal(await iconGroup.locator('[aria-busy="true"]').count(), 1)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-busy.png`), fullPage: true })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'scrapeFieldsModal') {
      const metrics = await checkScrapeActions({ page, name, width, theme, output })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'actressAvatarEditor') {
      const host = page.locator('[data-avatar-editor-host]')
      const tabs = host.getByRole('tablist', { name: '头像来源' })
      const snapshot = async suffix => {
        await page.evaluate(async () => {
          await document.fonts.ready
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime))
            .map(a => a.finished.catch(() => {})))
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}${suffix}.png`), fullPage: true, caret: 'hide' })
      }
      await tabs.waitFor()
      assert.equal(await tabs.getByRole('tab', { name: '当前' }).getAttribute('aria-selected'), 'true')
      assert.equal(await host.locator('[data-avatar-crop]').getAttribute('data-avatar-crop'), 'preview')
      const cropViewport = host.locator('[data-avatar-crop]').locator('..')
      assert.deepEqual(await cropViewport.evaluate(el => ({ width: getComputedStyle(el).width, height: getComputedStyle(el).height })),
        { width: '180px', height: '180px' })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await snapshot('')
      await host.getByRole('button', { name: '编辑裁剪' }).click()
      await host.getByRole('button', { name: '编辑中' }).waitFor()
      await host.getByRole('slider', { name: '缩放' }).waitFor()
      assert.ok(await host.getByRole('slider', { name: '缩放' }).isVisible())
      assert.deepEqual(await cropViewport.evaluate(el => ({ width: getComputedStyle(el).width, height: getComputedStyle(el).height })),
        { width: '180px', height: '180px' })
      await snapshot('-editing')
      await tabs.getByRole('tab', { name: '封面' }).click()
      assert.ok(await host.getByText('暂无关联封面').isVisible())
      await tabs.getByRole('tab', { name: '写真' }).click()
      assert.ok(await host.getByText('暂无写真').isVisible())
      await tabs.getByRole('tab', { name: '本地' }).click()
      await page.waitForFunction(el => el.getAttribute('aria-selected') === 'true',
        await tabs.getByRole('tab', { name: '本地' }).elementHandle())
      assert.ok(await host.getByRole('button', { name: '选择本地图片…' }).isVisible())
      await snapshot('-local')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'classificationPickerError') {
      const host = page.locator('[data-classification-picker-error-host]')
      const input = host.getByRole('combobox')
      const error = host.getByRole('alert')
      await error.waitFor()
      assert.equal(await error.textContent(), '机构候选加载失败，请稍后重试。')
      assert.equal(await error.evaluate(el => getComputedStyle(el).marginTop), '6px')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await input.fill('更新机构名')
      assert.equal(await input.inputValue(), '更新机构名')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'pluginDevKindToggle') {
      const host = page.locator('[data-plugin-dev-kind-toggle-host]')
      const video = host.getByRole('button', { name: '影片' })
      const actress = host.getByRole('button', { name: '演员' })
      await video.waitFor()
      assert.equal(await video.evaluate(el => getComputedStyle(el).flexGrow), '1')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await actress.click()
      assert.equal(await actress.evaluate(el => getComputedStyle(el).flexGrow), '1')
      await page.waitForFunction(() => document.querySelector('[aria-label="插件类型"] button:last-child')?.className.includes('kindButtonActive'))
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-selected.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'pluginDevWorkspaceSettings' || name === 'pluginDevWorkspaceStandalone') {
      const host = page.locator('[data-plugin-dev-workspace-host]')
      const shell = host.locator('[data-workbench-part="shell"]')
      const toolbar = host.locator('[data-workbench-part="toolbar"]')
      const main = host.locator('[data-workbench-part="main"]')
      await host.getByRole('button', { name: '连接设置' }).waitFor()
      assert.equal(await toolbar.evaluate(el => getComputedStyle(el).minHeight), '48px')
      assert.equal(await main.evaluate(el => getComputedStyle(el).display), 'grid')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      assert.equal(await main.evaluate(el => getComputedStyle(el).color), await page.evaluate(() => getComputedStyle(document.body).color))
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await host.getByRole('button', { name: '查看代码' }).click()
      await host.getByText('运行中', { exact: true }).waitFor()
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-running.png`) })
      await host.getByRole('button', { name: '连接设置' }).focus()
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-focus.png`) })
      assert.ok((await shell.boundingBox()).width > 0)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'appFormField') {
      const host = page.locator('[data-app-form-field-host]')
      const field = host.locator('label')
      const input = host.getByRole('textbox', { name: '媒体库名称' })
      await input.waitFor()
      const gap = await field.evaluate(el => getComputedStyle(el).gap)
      assert.equal(await field.evaluate(el => getComputedStyle(el).display), 'grid')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await input.fill('示例媒体库')
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-filled.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, gap })
      await page.close()
      continue
    }
    if (name === 'codeEditorSyntax') {
      const host = page.locator('[data-code-editor-host]')
      const input = host.getByRole('textbox', { name: '插件代码编辑器' })
      await input.waitFor()
      assert.ok((await host.locator('pre code span').count()) > 5)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await input.fill('const answer = "ABC-123"; // 更新后仍需高亮')
      assert.ok((await host.locator('pre code').textContent()).includes('更新后仍需高亮'))
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-edited.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'pluginDevCodeModal') {
      const dialog = page.getByRole('dialog')
      const viewer = dialog.getByLabel('插件代码')
      await viewer.waitFor()
      assert.equal(await viewer.evaluate(el => getComputedStyle(el).overflowY), 'auto')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await viewer.evaluate(el => { el.scrollTop = el.scrollHeight })
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-scrolled.png`) })
      await dialog.getByRole('button', { name: '关闭' }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'pluginDevAgentRail') {
      const host = page.locator('[data-plugin-dev-agent-rail-host]')
      const conversationTab = host.getByRole('tab', { name: /对话/ })
      const resultTab = host.getByRole('tab', { name: /结果/ })
      await conversationTab.waitFor()
      assert.equal(await conversationTab.getAttribute('aria-selected'), 'true')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await resultTab.click()
      await host.getByText('手工调试结果').waitFor()
      assert.equal(await resultTab.getAttribute('aria-selected'), 'true')
      await page.waitForTimeout(200)
      assert.notEqual(
        await resultTab.evaluate(el => getComputedStyle(el).backgroundColor),
        await conversationTab.evaluate(el => getComputedStyle(el).backgroundColor)
      )
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-result.png`) })
      await host.locator('#plugin-dev-panel-result details').first().locator('summary').click()
      await host.getByText('示例影片标题').waitFor()
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-expanded.png`) })
      await resultTab.press('ArrowLeft')
      assert.equal(await conversationTab.getAttribute('aria-selected'), 'true')
      assert.equal(await conversationTab.evaluate(el => el === document.activeElement), true)
      await conversationTab.press('ArrowRight')
      assert.equal(await resultTab.getAttribute('aria-selected'), 'true')
      assert.equal(await resultTab.evaluate(el => el === document.activeElement), true)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'pluginDevConversationActive' || name === 'pluginDevConversationEmpty') {
      const host = page.locator('[data-plugin-dev-conversation-host]')
      const input = host.locator('textarea')
      await input.waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      if (name === 'pluginDevConversationActive') {
        const outputDetails = host.locator('details').filter({ hasText: '查看输出' }).first()
        await outputDetails.locator('summary').click()
        assert.ok(await outputDetails.locator('pre').isVisible())
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-output.png`) })
      } else {
        await input.fill('请继续检查详情字段')
        await host.getByRole('button', { name: '发送给 Agent' }).click()
        assert.equal(await page.evaluate(() => window.lastPluginDevConversationAction), 'send')
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-feedback.png`) })
      }
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'pluginDevTargetVideo' || name === 'pluginDevTargetActress') {
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      const isActress = name === 'pluginDevTargetActress'
      const row = isActress
        ? dialog.getByRole('button', { name: '添加测试演员 测试演员甲' })
        : dialog.getByRole('button', { name: /ABC-123/ })
      await row.waitFor()
      assert.equal(await dialog.evaluate(el => Math.round(el.getBoundingClientRect().height)), Math.min(720, height - 48))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await row.click()
      assert.equal(await row.isDisabled(), true)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-selected.png`) })
      if (!isActress) {
        const poster = row.locator('span').first()
        await poster.evaluate(el => {
          const img = document.createElement('img')
          img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="38" height="38"><rect width="38" height="38" fill="teal"/></svg>'
          el.replaceChildren(img)
          document.documentElement.dataset.privacyMode = 'true'
          document.documentElement.dataset.privacyCovers = 'true'
        })
        assert.notEqual(await poster.locator('img').evaluate(el => getComputedStyle(el).filter), 'none')
        assert.notEqual(await poster.evaluate(el => getComputedStyle(el, '::after').content), 'none')
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-privacy.png`) })
      }
      await dialog.getByRole('textbox', { name: '搜索测试目标' }).fill('not-found')
      await dialog.getByText('没有找到匹配条目').waitFor()
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-empty.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'pluginDevConfigCreate' || name === 'pluginDevConfigDebug') {
      const host = page.locator('[data-plugin-dev-rail-host]')
      const rail = host.locator('aside')
      await rail.getByText('任务配置').waitFor()
      const metrics = await rail.evaluate(el => {
        const rect = el.getBoundingClientRect()
        const scroll = el.querySelector('[data-plugin-dev-config-scroll]')
        return { width: rect.width, height: rect.height,
          scrollOverflowY: scroll ? getComputedStyle(scroll).overflowY : null,
          scrollGutter: scroll ? getComputedStyle(scroll).scrollbarGutter : null }
      })
      assert.equal(metrics.scrollOverflowY, 'auto')
      assert.equal(metrics.scrollGutter, 'stable')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true })
      const action = name === 'pluginDevConfigDebug' ? 'AI调试' : 'AI开发'
      await rail.getByRole('button', { name: action }).click()
      assert.equal(await page.evaluate(() => window.lastPluginDevRailAction), 'start')
      await rail.getByText('支持字段', { exact: true }).last().scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-fields.png`), fullPage: true })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'pluginFieldTags') {
      const host = page.locator('[data-plugin-field-tags-host]')
      const removers = host.getByRole('button', { name: /^移除字段 / })
      await removers.first().waitFor()
      assert.equal(await removers.count(), 2)
      assert.equal(await host.getByRole('button', { name: '自定义支持字段' }).isDisabled(), true)
      assert.equal(await removers.first().evaluate(el => getComputedStyle(el).width), '18px')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await removers.first().hover()
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-hover.png`) })
      await removers.first().click()
      assert.equal(await removers.count(), 1)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'aliasTagEditor') {
      const host = page.locator('[data-alias-editor-host]')
      const inputs = host.getByRole('textbox', { name: '添加别名' })
      const promote = host.getByRole('button', { name: '示例别名', exact: true })
      const remove = host.getByRole('button', { name: '移除别名 示例别名' })
      await inputs.first().waitFor()
      assert.equal(await inputs.count(), 2)
      assert.equal(await inputs.nth(1).isDisabled(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await promote.hover()
      await page.waitForTimeout(180)
      assert.equal(await remove.evaluate(el => getComputedStyle(el).width), '18px')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-hover.png`) })
      await promote.click()
      assert.equal(await page.evaluate(() => window.lastPromotedAlias), '示例别名')
      await remove.click()
      assert.equal(await host.getByText('示例别名').count(), 0)
      await inputs.first().fill('新别名甲,新别名乙')
      await inputs.first().press('Enter')
      assert.equal(await host.getByText('新别名甲').count(), 1)
      assert.equal(await host.getByText('新别名乙').count(), 1)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'classificationCards') {
      const host = page.locator('[data-classification-cards-host]')
      const cards = host.getByRole('button')
      await cards.nth(2).waitFor()
      assert.equal(await cards.count(), 3)
      const images = host.locator('img')
      await images.evaluateAll(elements => Promise.all(elements.map(image => image.decode())))
      assert.equal(await images.nth(0).evaluate(img => getComputedStyle(img).objectFit), 'contain')
      assert.equal(await images.nth(1).evaluate(img => getComputedStyle(img).objectFit), 'cover')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.waitForTimeout(180)
      assert.equal(await cards.first().evaluate(el => getComputedStyle(el).color),
        await page.evaluate(() => getComputedStyle(document.body).color))
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.evaluate(() => {
        document.documentElement.dataset.privacyMode = 'true'
        document.documentElement.dataset.privacyCovers = 'true'
      })
      assert.notEqual(await images.first().evaluate(img => getComputedStyle(img).filter), 'none')
      assert.equal(await images.first().locator('..').evaluate(el => getComputedStyle(el, '::after').content), '""')
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-privacy.png`) })
      await cards.first().click()
      assert.equal(await page.evaluate(() => window.lastFacetCard), 'organization')
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'relatedLinksEditor') {
      const host = page.locator('[data-related-links-editor-host]')
      const firstLabel = host.getByRole('textbox', { name: '链接 1 名称' })
      await firstLabel.waitFor()
      const secondLabel = host.getByRole('textbox', { name: '链接 2 名称' })
      assert.equal(await firstLabel.inputValue(), '官网资料')
      assert.equal(await secondLabel.inputValue(), '补充链接')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await host.getByRole('button', { name: '上移链接 2' }).click()
      assert.equal(await firstLabel.inputValue(), '补充链接')
      await host.getByRole('button', { name: '添加链接' }).click()
      assert.equal(await host.getByRole('textbox', { name: '链接 3 地址' }).inputValue(), '')
      await page.mouse.move(0, 0)
      await page.waitForTimeout(180)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-added.png`) })
      await host.getByRole('button', { name: '删除链接 3' }).click()
      assert.equal(await host.getByRole('textbox', { name: '链接 3 地址' }).count(), 0)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'playlistDetail') {
      const detail = page.locator('[data-playlist-detail]')
      await detail.waitFor()
      await page.getByRole('heading', { name: '视觉验收清单' }).waitFor()
      const columns = await detail.locator(':scope > div').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)
      assert.equal(columns, width <= 760 ? 1 : 3)
      const sectionTitle = detail.getByText('影片', { exact: true })
      assert.equal(await sectionTitle.evaluate(el => getComputedStyle(el).marginTop), '0px')
      assert.equal(await sectionTitle.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--text-primary)'
        document.body.append(probe)
        const matches = getComputedStyle(el).color === getComputedStyle(probe).color
        probe.remove()
        return matches
      }), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'playlistPicker') {
      const dialog = page.getByRole('dialog', { name: /加入播放清单/ })
      await dialog.waitFor()
      await page.getByText('带封面清单', { exact: true }).waitFor()
      const search = page.getByRole('textbox', { name: '搜索或输入新清单名称' })
      assert.ok(await search.isVisible())
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      const remove = page.getByRole('button', { name: '移出', exact: true })
      await remove.hover()
      assert.equal(await remove.evaluate(button => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--danger)'
        document.body.append(probe)
        const matches = getComputedStyle(button).color === getComputedStyle(probe).color
        probe.remove()
        return matches
      }), true)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, bounds })
      await page.close()
      continue
    }
    if (name === 'playlistCards') {
      const cards = page.locator('[data-playlist-card]')
      await cards.first().waitFor()
      assert.equal(await cards.count(), 2)
      assert.equal((await cards.first().boundingBox()).height, 112)
      assert.equal(await cards.first().getAttribute('data-active'), 'true')
      await cards.nth(1).click()
      assert.equal(await cards.nth(1).getAttribute('data-active'), 'true')
      const rows = page.locator('[data-playlist-picker-row]')
      assert.equal(await rows.count(), 2)
      assert.equal((await rows.first().boundingBox()).height, 86)
      await rows.nth(1).click()
      assert.equal(await rows.nth(1).getAttribute('aria-pressed'), 'true')
      await page.locator('[data-variant] img').evaluateAll(images => images.forEach(image => {
        image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="teal"/></svg>')
      }))
      await page.evaluate(() => {
        document.documentElement.dataset.privacyMode = 'true'
        document.documentElement.dataset.privacyCovers = 'true'
      })
      const cover = page.locator('[data-variant="card"]').first()
      assert.equal((await cover.boundingBox()).width, 82)
      assert.notEqual(await cover.locator('img').evaluate(image => getComputedStyle(image).filter), 'none')
      assert.equal(await cover.evaluate(el => getComputedStyle(el, '::after').content), '""')
      assert.equal(await cover.getByText('8').evaluate(el => getComputedStyle(el).zIndex), '2')
      assert.equal((await rows.first().locator('[data-variant="pick"]').boundingBox()).width, 68)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'selection') {
      const toolbar = page.getByRole('toolbar', { name: '多选操作', exact: true })
      await toolbar.waitFor()
      const conflictButton = page.getByRole('button', { name: '待确认测试', exact: true })
      const conflictStyle = await conflictButton.evaluate(el => {
        const style = getComputedStyle(el)
        const probe = document.createElement('span')
        probe.style.color = 'var(--text-warning)'
        probe.style.borderColor = 'var(--border-warning)'
        probe.style.backgroundColor = 'var(--surface-warning)'
        document.body.append(probe)
        const expected = getComputedStyle(probe)
        const result = { actual: [style.color, style.borderColor, style.backgroundColor],
          expected: [expected.color, expected.borderColor, expected.backgroundColor] }
        probe.remove()
        return result
      })
      assert.deepEqual(conflictStyle.actual, conflictStyle.expected)
      assert.equal((await toolbar.boundingBox()).height, 36)
      const action = page.getByRole('button', { name: '批量编辑', exact: true })
      assert.equal((await action.boundingBox()).height, 28)
      assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isDisabled(), true)
      await action.click()
      await page.getByText('已选择 2 项', { exact: true }).waitFor()
      await page.getByRole('button', { name: '取消选择', exact: true }).click()
      await page.getByText('已选择 0 项', { exact: true }).waitFor()
      const tag = page.getByRole('option', { name: /示例标签/ })
      await tag.click()
      assert.equal(await tag.getAttribute('aria-selected'), 'true')
      await page.getByRole('textbox', { name: '搜索标签', exact: true }).fill('无匹配')
      await page.getByText('无匹配标签', { exact: true }).waitFor()
      const resource = page.getByRole('checkbox').first()
      assert.equal(await resource.isChecked(), false)
      await resource.check()
      assert.equal(await resource.isChecked(), true)
      await resource.uncheck()
      assert.equal(await resource.isChecked(), false)
      const sort = page.locator('[aria-label="测试排序"]')
      assert.equal((await sort.boundingBox()).height, 36)
      assert.equal(await sort.getByRole('button', { name: '名称', exact: true }).evaluate(el => getComputedStyle(el).paddingLeft), '9px')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.getByRole('button', { name: '日期', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: '日期', exact: true }).getAttribute('aria-pressed'), 'true')
      const direction = page.getByRole('button', { name: '日期升序', exact: true })
      assert.equal((await direction.boundingBox()).width, 32)
      await direction.click()
      await page.getByRole('button', { name: '日期降序', exact: true }).waitFor()
      await sort.getByRole('button', { name: '测试排序全部选项', exact: true }).click()
      await page.getByRole('option', { name: '外部评分', exact: true }).click()
      await sort.getByRole('button', { name: '外部评分降序', exact: true }).waitFor()
      const more = sort.getByRole('button', { name: '测试排序全部选项', exact: true })
      assert.equal(await more.innerText(), '更多')
      assert.equal(await more.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--text-accent)'
        el.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return getComputedStyle(el).color === expected
      }), true)
      const filter = page.getByRole('button', { name: '筛选', exact: true })
      assert.equal(await filter.getAttribute('aria-expanded'), 'false')
      await filter.click()
      assert.equal(await filter.getAttribute('aria-expanded'), 'true')
      await page.waitForFunction(() => {
        const icon = document.querySelector('button[aria-haspopup="dialog"] svg')
        return getComputedStyle(icon).transform.startsWith('matrix(-1,')
      })
      const panel = page.getByRole('dialog', { name: '筛选', exact: true })
      await panel.waitFor()
      const actressStatusSelect = panel.locator('[data-variant="filter"] button').first()
      await actressStatusSelect.click()
      await page.getByRole('listbox').getByRole('option', { name: '刮削成功', exact: true }).click()
      await panel.waitFor()
      assert.equal(await actressStatusSelect.innerText(), '刮削成功')
      const panelBounds = await panel.boundingBox()
      assert.equal(panelBounds.width, 380)
      assert.ok(panelBounds.height > 100 && panelBounds.height < height)
      await panel.getByRole('button', { name: '重置', exact: true }).click()
      await panel.getByRole('button', { name: '完成', exact: true }).click()
      await panel.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: '切换媒体库筛选测试', exact: true }).click()
      await filter.click()
      await panel.waitFor()
      const libraryStatusSelect = panel.locator('[data-variant="filter"] button').first()
      await libraryStatusSelect.click()
      await page.getByRole('listbox').getByRole('option', { name: '已刮削', exact: true }).click()
      await panel.waitFor()
      assert.equal(await libraryStatusSelect.innerText(), '已刮削')
      const prefix = panel.getByPlaceholder('输入系列前缀')
      await prefix.fill('abc')
      assert.equal(await prefix.inputValue(), 'ABC')
      const fields = await prefix.evaluate(el => {
        const field = el.closest('label')
        const grid = field.parentElement
        return { display: getComputedStyle(grid).display, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, span: getComputedStyle(field).gridColumn }
      })
      assert.deepEqual(fields, { display: 'grid', columns: 2, span: '1 / -1' })
      await panel.getByText('须同时包含', { exact: true }).waitFor()
      await panel.getByRole('option', { name: /示例标签/ }).click()
      await panel.getByRole('button', { name: '重置', exact: true }).click()
      assert.equal(await prefix.inputValue(), '')
      assert.equal(await panel.getByRole('option', { name: /示例标签/ }).getAttribute('aria-selected'), 'false')
      await page.screenshot({ path: path.join(output, `library-filter-${width}-${theme}.png`) })
      await panel.getByRole('button', { name: '完成', exact: true }).click()
      await panel.waitFor({ state: 'detached' })
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'imageImport') {
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.equal(await page.getByRole('button', { name: '导入图片', exact: true }).isDisabled(), true)
      await page.getByRole('tab', { name: '图片链接', exact: true }).click()
      await page.getByPlaceholder('输入一个图片链接').fill('https://example.invalid/test.svg')
      await page.getByRole('button', { name: '加载图片', exact: true }).click()
      await page.getByText('test.svg', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: '导入图片', exact: true }).isDisabled(), false)
      const bounds = await dialog.boundingBox()
      assert.equal(bounds.width, Math.min(760, width - 48))
      if (width === 640) {
        const input = await page.getByPlaceholder('输入一个图片链接').boundingBox()
        const load = await page.getByRole('button', { name: '加载图片', exact: true }).boundingBox()
        assert.ok(load.y >= input.y + input.height)
      }
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      const remove = page.getByRole('button', { name: '移除待导入图片 1', exact: true })
      await remove.focus()
      await page.keyboard.press('Enter')
      await page.getByText('test.svg', { exact: true }).waitFor({ state: 'detached' })
      assert.equal(await page.getByRole('button', { name: '导入图片', exact: true }).isDisabled(), true)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'crypto') {
      await page.waitForFunction(() => typeof window.emitAssetProgress === 'function')
      assert.equal(await page.getByRole('alertdialog').count(), 0)
      for (const [phase, title] of [['encrypt', '正在加密图片'], ['decrypt', '正在解密图片'], ['relocate', '正在迁移媒体资源']]) {
        await page.evaluate(phase => window.emitAssetProgress({ status: 'running', phase, total: 100, current: 25, currentFile: 'covers/example.jpg' }), phase)
        await page.getByRole('heading', { name: title, exact: true }).waitFor()
        const overlay = page.getByRole('alertdialog')
        const bounds = await overlay.boundingBox()
        assert.equal(bounds.width, width)
        assert.equal(bounds.height, height)
        await page.getByText('进度 25/100', { exact: true }).waitFor()
      }
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.evaluate(() => window.emitAssetProgress({ status: 'done', phase: 'relocate', total: 100, current: 100 }))
      await page.getByRole('alertdialog').waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'faceScan') {
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      const progress = page.getByRole('progressbar', { name: '人脸识别进度' })
      assert.equal(await progress.getAttribute('value'), '35')
      assert.equal((await progress.boundingBox()).height, 8)
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height)
      await page.getByText('当前：演员进度测试', { exact: true }).waitFor()
      await page.getByRole('button', { name: '取消扫描', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: '正在取消…', exact: true }).isDisabled(), true)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'actressGrid') {
      const cards = page.locator('[data-actress-card]')
      await cards.first().waitFor()
      assert.ok(await cards.count() < 200)
      const metrics = await cards.first().evaluate(el => {
        const viewport = el.parentElement.parentElement.parentElement
        return { height: viewport.clientHeight, overflowX: getComputedStyle(viewport).overflowX,
          innerWidth: viewport.firstElementChild.getBoundingClientRect().width, width: viewport.clientWidth,
          inlineInnerWidth: viewport.firstElementChild.style.width,
          gutter: getComputedStyle(viewport).scrollbarGutter, gap: el.parentElement.getBoundingClientRect().height - el.getBoundingClientRect().height }
      })
      assert.equal(metrics.height, height)
      assert.equal(metrics.overflowX, 'hidden')
      assert.equal(metrics.gutter, 'stable')
      assert.equal(metrics.gap, 12)
      assert.ok(Math.abs(metrics.innerWidth - metrics.width) < 0.1)
      assert.equal(metrics.inlineInnerWidth, '')
      await page.getByRole('button', { name: '选择 演员-1', exact: true }).click()
      assert.equal(await cards.first().getAttribute('data-selected'), 'true')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await cards.first().evaluate(el => { el.parentElement.parentElement.parentElement.scrollTop = 1500 })
      await page.getByRole('button', { name: '取消选择 演员-1', exact: true }).waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'covers') {
      const thumbs = page.locator('[data-mode]')
      await thumbs.first().waitFor()
      assert.equal(await thumbs.first().evaluate(el => getComputedStyle(el).aspectRatio), '7 / 10')
      assert.equal((await thumbs.nth(1).boundingBox()).height, 180)
      await page.getByRole('button', { name: '横版封面', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[data-mode]')?.getAttribute('data-mode') === 'landscape')
      await page.waitForFunction(() => {
        const [numerator, denominator = '1'] = getComputedStyle(document.querySelector('[data-mode]')).aspectRatio.split('/')
        return Math.abs(Number(numerator) / Number(denominator) - 800 / 538) < 0.001
      })
      assert.equal(await thumbs.nth(1).evaluate(el => getComputedStyle(el).aspectRatio), 'auto')
      // Supply synthetic image pixels locally; do not access the real media protocol.
      await page.locator('[data-video-card] img').evaluateAll(images => images.forEach(image => {
        image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect width="100" height="200" fill="teal"/></svg>')
      }))
      await page.waitForFunction(() => [...document.querySelectorAll('[data-video-card] img')].every(el => el.dataset.tall === 'true'))
      assert.equal(await page.locator('[data-video-card] img').first().evaluate(el => getComputedStyle(el).objectFit), 'contain')
      await page.evaluate(() => {
        document.documentElement.dataset.privacyMode = 'true'
        document.documentElement.dataset.privacyCovers = 'true'
      })
      assert.notEqual(await page.locator('[data-video-card] img').first().evaluate(el => getComputedStyle(el).filter), 'none')
      assert.equal(await thumbs.first().evaluate(el => getComputedStyle(el, '::after').content), '""')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    if (name === 'grid') {
      const first = page.locator('[data-video-card]').first()
      await first.waitFor()
      assert.ok(await page.locator('[data-video-card]').count() < 200)
      const metrics = await first.evaluate(el => {
        const cell = el.parentElement, viewport = cell.parentElement.parentElement
        const cardBounds = el.getBoundingClientRect(), cellBounds = cell.getBoundingClientRect()
        return { gap: cellBounds.height - cardBounds.height, gutter: getComputedStyle(viewport).scrollbarGutter,
          innerWidth: cell.parentElement.getBoundingClientRect().width, width: viewport.clientWidth,
          inlineInnerWidth: cell.parentElement.style.width,
          overflowX: getComputedStyle(viewport).overflowX, height: viewport.clientHeight }
      })
      assert.equal(metrics.gap, 12)
      assert.equal(metrics.gutter, 'stable')
      assert.equal(metrics.overflowX, 'hidden')
      assert.equal(metrics.height, height)
      assert.ok(Math.abs(metrics.innerWidth - metrics.width) < 0.1)
      assert.equal(metrics.inlineInnerWidth, '')
      await first.click()
      assert.equal(await first.getAttribute('data-selected'), 'true')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      await page.getByRole('button', { name: '浏览模式', exact: true }).click()
      await first.hover()
      const edit = page.getByRole('button', { name: '编辑 TEST-1 元数据', exact: true })
      assert.equal((await edit.boundingBox()).width, 26)
      await edit.click()
      await page.getByText('编辑已触发', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'TEST-1 功能菜单', exact: true }).click()
      await page.getByRole('menuitem', { name: '删除影片', exact: true }).click()
      await page.getByText('删除已触发', { exact: true }).waitFor()
      assert.equal(await page.getByRole('menu').count(), 0)
      await page.getByRole('button', { name: '默认清单操作', exact: true }).click()
      await first.hover()
      const favorite = first.getByRole('button', { name: '加入我喜欢', exact: true })
      const watch = first.getByRole('button', { name: '加入稍后观看', exact: true })
      for (const button of [favorite, watch]) {
        assert.equal((await button.boundingBox()).width, 26)
        assert.equal(await button.evaluate(el => getComputedStyle(el).position), 'absolute')
      }
      assert.equal(await favorite.evaluate(el => getComputedStyle(el).left), '6px')
      assert.equal(await watch.evaluate(el => getComputedStyle(el).top), '6px')
      await favorite.click()
      await first.getByRole('button', { name: '移出我喜欢', exact: true }).waitFor()
      assert.equal(await first.getByRole('button', { name: '移出我喜欢', exact: true }).getAttribute('aria-pressed'), 'true')
      await watch.click()
      await first.getByRole('button', { name: '移出稍后观看', exact: true }).waitFor()
      await first.getByRole('button', { name: '移出稍后观看', exact: true }).click()
      await first.getByRole('button', { name: '加入稍后观看', exact: true }).waitFor()
      assert.equal(await first.getByRole('button', { name: '编辑 TEST-1 元数据', exact: true }).count(), 0)
      await first.getByRole('button', { name: 'TEST-1 功能菜单', exact: true }).click()
      await page.getByRole('menuitem', { name: '编辑元数据', exact: true }).click()
      await page.getByText('编辑已触发', { exact: true }).waitFor()
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-builtin.png`) })
      await first.evaluate(el => { el.parentElement.parentElement.parentElement.scrollTop = 1500 })
      await page.waitForFunction(() => {
        const code = document.querySelector('[data-video-card] [data-video-code]')?.textContent
        return Boolean(code && code !== 'TEST-1')
      })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme, metrics })
      await page.close()
      continue
    }
    if (name === 'controls') {
      const toolbar = page.getByRole('group', { name: 'toolbar', exact: true })
      await toolbar.waitFor()
      const tileAction = page.getByRole('button', { name: '移除测试图片', exact: true })
      assert.equal(await tileAction.evaluate(el => getComputedStyle(el).opacity), '0')
      await page.locator('[aria-label="操作显隐测试"]').hover()
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="移除测试图片"]')).opacity === '1')
      await toolbar.hover()
      await tileAction.focus()
      await page.waitForFunction(() => getComputedStyle(document.activeElement).opacity === '1')
      const actressSelection = page.getByRole('button', { name: '选择 测试演员', exact: true })
      await actressSelection.focus()
      await page.waitForFunction(() => getComputedStyle(document.activeElement).opacity === '1')
      await page.keyboard.press('Space')
      assert.equal(await page.getByRole('button', { name: '取消选择 测试演员', exact: true }).getAttribute('aria-pressed'), 'true')
      const avatar = page.getByRole('img', { name: '测试演员', exact: true })
      assert.equal((await avatar.boundingBox()).width, 72)
      const deleteActress = page.getByRole('button', { name: '删除演员 测试演员', exact: true })
      await deleteActress.focus()
      assert.equal(await deleteActress.evaluate(el => getComputedStyle(el).top), '6px')
      assert.equal(await deleteActress.evaluate(el => getComputedStyle(el).right), '6px')
      assert.equal((await toolbar.boundingBox()).height, 36)
      await toolbar.getByRole('button', { name: '男', exact: true }).click()
      assert.equal(await toolbar.getByRole('button', { name: '男', exact: true }).getAttribute('aria-pressed'), 'true')
      for (const variant of ['default', 'toolbar', 'stretch']) {
        const group = page.getByRole('group', { name: variant, exact: true })
        assert.equal(await group.getByRole('button', { name: '不可用', exact: true }).isDisabled(), true)
        assert.equal(await group.getByRole('button', { name: '女', exact: true }).getAttribute('aria-pressed'), 'false')
      }
      await page.keyboard.press('Tab')
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
      const selectButton = page.getByRole('button', { name: '下方展开', exact: true })
      const selectStyles = await selectButton.evaluate(el => {
        const style = getComputedStyle(el)
        return { minHeight: style.minHeight, paddingTop: style.paddingTop, image: style.backgroundImage, position: getComputedStyle(el.parentElement).position }
      })
      assert.equal(selectStyles.minHeight, '32px')
      assert.equal(selectStyles.paddingTop, '8px')
      assert.ok(selectStyles.image.includes('linear-gradient'))
      assert.equal(selectStyles.position, 'relative')
      assert.equal(await selectButton.evaluate(el => getComputedStyle(el).fontSize), '13px')
      assert.equal(await page.getByRole('button', { name: '设置选择', exact: true }).evaluate(el => getComputedStyle(el).fontSize), '12px')
      await selectButton.click()
      const menu = page.getByRole('listbox')
      await menu.waitFor()
      assert.equal(await menu.getAttribute('data-placement'), 'bottom')
      assert.equal(await menu.getByRole('option', { name: '禁用选项', exact: true }).isDisabled(), true)
      await menu.getByRole('option', { name: '末项', exact: true }).click()
      await menu.waitFor({ state: 'detached' })
      assert.equal(await page.getByRole('button', { name: '下方展开', exact: true }).innerText(), '末项')
      const bottom = page.getByRole('button', { name: '上方展开', exact: true })
      await bottom.click()
      assert.equal(await menu.getAttribute('data-placement'), 'top')
      const bounds = await menu.boundingBox()
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height)
      await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-select.png`) })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      assert.equal(await bottom.evaluate(el => el === document.activeElement), true)
      assert.deepEqual(errors, [])
      results.push({ name, width, height, theme })
      await page.close()
      continue
    }
    await page.getByPlaceholder(/搜索番号/).waitFor()
    await page.getByText(name === 'home' ? '暂无可发现的影片' : '输入番号、标题或演员名称开始搜索。', { exact: true }).waitFor()
    const metrics = await page.locator('[data-scroll-viewport]').evaluate(el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect()
      return { width: rect.width, height: rect.height, bottom: rect.bottom, overflowY: style.overflowY, gutter: style.scrollbarGutter }
    })
    assert.ok(metrics.height > 100 && metrics.bottom <= height + 1)
    assert.equal(metrics.overflowY, name === 'home' ? 'auto' : 'hidden')
    if (name === 'home') assert.equal(metrics.gutter, 'stable')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`) })
    const search = page.getByRole('searchbox', { name: '跨媒体库搜索', exact: true })
    await search.fill('ABC-123')
    await page.getByText('没有匹配的影片', { exact: true }).waitFor()
    assert.equal(await search.inputValue(), 'ABC-123')
    assert.equal(await search.evaluate(el => el === document.activeElement), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-search-state.png`) })
    assert.deepEqual(errors, [])
    results.push({ name, width, height, theme, metrics })
    await page.close()
  }
  assert.ok(results.length > 0, 'No CSS fixtures matched the requested selection')
  const exercisedFixtures = new Set(results.map(result => result.name))
  for (const name of requestedFixtures) assert.ok(exercisedFixtures.has(name), `CSS fixture was not exercised: ${name}`)
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ output, passed: results.length }))
} finally {
  await browser?.close()
  await server?.close()
}
