import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { declarationsFor as readDeclarations } from '../test/cssDeclarations'

const cssPath = 'src/renderer/src/pages/MediaLibrarySettingsPage.module.css'

function declarationsFor(selector: string): Map<string, string> {
  return readDeclarations(cssPath, selector, { rootRulesOnly: true })
}

describe('MediaLibrarySettingsPage layout', () => {
  it('uses the application settings width token and stays left aligned', () => {
    const declarations = declarationsFor('.page')

    assert.equal(declarations.get('width'), '100%')
    assert.equal(declarations.get('max-width'), 'var(--settings-content-max)')
    assert.equal(declarations.get('margin'), '0')
  })

  it('keeps compact library context above the old-style import workspace', () => {
    const header = declarationsFor('.header')
    const importPanel = declarationsFor('.importPanel')
    const importWorkspace = declarationsFor('.importWorkspace')
    const sourcePanel = declarationsFor('.sourcePanel')
    const sourcePanelIcon = declarationsFor('.sourcePanelIcon')
    const scanConsole = declarationsFor('.scanConsole')
    const scanPanelIcon = declarationsFor('.scanPanelIcon')
    const scanSettingsPanel = declarationsFor('.scanSettingsPanel')
    const scanSettingsPanelIcon = declarationsFor('.scanSettingsPanelIcon')
    const scanDuration = declarationsFor('.scanDuration')
    const scanHistory = declarationsFor('.scanHistory')
    const scanInterval = declarationsFor(
      '.scanAutoInterval > .scanIntervalSelect'
    )
    const component = readFileSync(
      path.resolve('src/renderer/src/pages/MediaLibrarySettingsPage.tsx'),
      'utf8'
    )
    const tabs = readFileSync(
      path.resolve('src/renderer/src/pages/MediaLibrarySettingsTabs.tsx'),
      'utf8'
    )
    const settingsPage = readFileSync(
      path.resolve('src/renderer/src/pages/SettingsPage.tsx'),
      'utf8'
    )

    assert.equal(header.get('display'), 'grid')
    assert.equal(header.get('background'), 'var(--surface-panel)')
    assert.equal(importPanel.get('padding'), '0')
    assert.equal(importPanel.get('border'), '0')
    assert.equal(importPanel.get('background'), 'transparent')
    assert.equal(importWorkspace.get('display'), 'grid')
    assert.equal(importWorkspace.get('gap'), '12px')
    assert.equal(sourcePanel.get('display'), 'flex')
    assert.equal(sourcePanel.get('padding'), '12px')
    assert.equal(sourcePanel.get('border'), '1px solid var(--border-subtle)')
    assert.equal(sourcePanelIcon.get('width'), '26px')
    assert.equal(sourcePanelIcon.get('height'), '26px')
    assert.equal(scanConsole.get('display'), 'flex')
    assert.equal(scanConsole.get('padding'), '12px')
    assert.equal(scanConsole.get('background'), 'var(--surface-control)')
    assert.equal(scanPanelIcon.get('width'), '26px')
    assert.equal(scanPanelIcon.get('height'), '26px')
    assert.equal(scanSettingsPanel.get('display'), 'flex')
    assert.equal(scanSettingsPanel.get('border'), '1px solid var(--border-subtle)')
    assert.equal(scanSettingsPanelIcon.get('width'), '26px')
    assert.equal(scanSettingsPanelIcon.get('height'), '26px')
    assert.equal(scanDuration.get('display'), 'inline-flex')
    assert.equal(scanDuration.get('min-height'), 'var(--control-h-md)')
    assert.equal(scanHistory.get('border-top'), '1px solid var(--border-subtle)')
    assert.equal(scanInterval.get('width'), '132px')
    assert.equal(scanInterval.get('min-width'), '132px')
    assert.equal(scanInterval.get('flex'), '0 0 132px')
    assert.doesNotMatch(component, /aria-label="媒体库操作"/)
    assert.doesNotMatch(component, />\s*打开媒体库\s*</)
    assert.doesNotMatch(component, /styles\.headerActions/)
    assert.doesNotMatch(component, />当前媒体库</)
    assert.doesNotMatch(component, />切换媒体库</)
    assert.match(component, /requestArchive=\{\(\) => setLifecycleConfirm\('archive'\)\}/)
    assert.match(component, /restoreLibrary=\{restoreLibrary\}/)
    assert.match(component, /tab === 'sources' \? ` \$\{styles\.importPanel\}` : ''/)
    assert.doesNotMatch(component, /contextLinks/)
    assert.ok(component.indexOf('<header') < component.indexOf('<SettingsTabBar'))
    assert.match(settingsPage, /tabsPlacement=\{activeGroup\.id === 'library'/)
    assert.match(
      settingsPage,
      /mediaLibrarySettingsPath\(selectedSettingsLibrary\.id, nextTab\)/
    )
    assert.match(tabs, /function SourcesAndScanSettingsTab/)
    assert.match(tabs, /aria-label="来源目录"/)
    assert.match(tabs, /<h4>来源目录<\/h4>/)
    assert.match(tabs, /aria-label="扫描导入"/)
    assert.match(tabs, /<h4>扫描导入<\/h4>/)
    assert.match(tabs, /aria-label="扫描设置"/)
    assert.match(tabs, /<h4>扫描设置<\/h4>/)
    assert.doesNotMatch(tabs, />媒体库导入</)
    assert.doesNotMatch(tabs, /styles\.importHeading/)
    assert.doesNotMatch(tabs, /styles\.importStatus/)
    assert.ok(
      tabs.indexOf('aria-label="来源目录"') <
        tabs.indexOf('aria-label="扫描导入"') &&
        tabs.indexOf('aria-label="扫描导入"') <
          tabs.indexOf('aria-label="扫描设置"')
    )
    assert.match(tabs, /scan\.running \? scan\.cancel\(\) : scan\.start\(\)/)
    assert.match(tabs, /<SettingsNumberStepper/)
    assert.match(tabs, /aria-label="最短导入时长（分钟）"/)
    assert.match(tabs, /function ScanHistorySummary/)
    assert.match(tabs, />最近一次扫描</)
    assert.match(tabs, /<SettingsSectionBlock/)
    assert.match(tabs, /settings-toggle-list settings-toggle-list--compact/)
    assert.match(tabs, /<SettingsSwitchRow/)
    assert.match(tabs, /仍被任一清单引用的影片会保留，不会被自动清理/)
    assert.match(tabs, /archived \? '恢复媒体库' : '归档媒体库'/)
    assert.match(tabs, />\s*永久删除\s*</)
    assert.match(tabs, /styles\.scanAutoInterval/)
    assert.match(tabs, /updateConfigImmediately/)
    assert.doesNotMatch(tabs, /保存扫描设置/)
    assert.match(component, /const updateConfigImmediately = async/)
  })
})
