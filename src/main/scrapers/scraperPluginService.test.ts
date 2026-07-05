import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import type { ScraperPluginKind, ScraperPluginPackage } from '@shared/types'
import {
  builtInDescriptor,
  createCompositeScraper,
  exportScraperPluginPackage,
  importScraperPluginPackage,
  listBundledPluginDescriptors,
  listCompositePluginDescriptors,
  listMergedPluginDescriptors,
  listUserPluginDescriptors,
  loadUserActressScrapers,
  loadUserVideoScrapers,
  readScraperPluginPackage,
  readScraperPluginPackageForExport
} from './scraperPluginService'
import { normalizeVideoScrapeResult } from './scraperResultValidation'

let tempRoot: string | null = null
let oldUserData: string | null = null
let oldBundledRoot: string | null = null

beforeEach(() => {
  oldUserData = process.env.JAVDEX_TEST_USER_DATA ?? null
  oldBundledRoot = process.env.JAVDEX_BUNDLED_PLUGINS_ROOT ?? null
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scraper-plugins-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  process.env.JAVDEX_BUNDLED_PLUGINS_ROOT = path.join(process.cwd(), 'src/main/bundled-plugins')
})

afterEach(() => {
  if (oldUserData) {
    process.env.JAVDEX_TEST_USER_DATA = oldUserData
    oldUserData = null
  } else {
    delete process.env.JAVDEX_TEST_USER_DATA
  }
  if (oldBundledRoot) {
    process.env.JAVDEX_BUNDLED_PLUGINS_ROOT = oldBundledRoot
    oldBundledRoot = null
  } else {
    delete process.env.JAVDEX_BUNDLED_PLUGINS_ROOT
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

function writePackage(pkg: ScraperPluginPackage): string {
  const name = pkg.name?.replace(/[^\w.-]+/g, '_') || 'plugin'
  const filePath = path.join(tempRoot!, `${name}.avscraper.json`)
  fs.writeFileSync(filePath, JSON.stringify(pkg), 'utf-8')
  return filePath
}

function pluginPackage(
  kind: ScraperPluginKind,
  name: string,
  code = kind === 'video'
    ? "module.exports = { async parseVideo(ctx) { return { code: ctx.code, title: 'Plugin Title' } } }"
    : "module.exports = { async parseActress(ctx) { return { mainName: ctx.mainName, nameEn: 'Alice Example' } } }"
): ScraperPluginPackage {
  return {
    schemaVersion: 1,
    kind,
    name,
    version: '1.0.0',
    description: 'Test plugin',
    code
  }
}

describe('scraperPluginService', () => {
  it('describes bundled video scraper fields from shipped manifests', () => {
    const javdb = builtInDescriptor('video', 'JavDB')
    assert.equal(javdb.exportable, true)
    assert.equal(javdb.supportedFields.includes('samples'), true)

    const javLibrary = builtInDescriptor('video', 'JavLibrary')
    assert.equal(javLibrary.supportedFields.includes('rating'), true)
    assert.equal(javLibrary.supportedFields.includes('source'), true)
  })

  it('describes bundled actress scraper fields from shipped manifests', () => {
    const xslist = builtInDescriptor('actress', 'Xslist')
    assert.equal(xslist.supportedFields.includes('gallery'), true)
    assert.equal(xslist.supportedFields.includes('profileSummary'), true)
    assert.equal(xslist.supportedFields.includes('heightCm'), true)
    assert.equal(xslist.supportedFields.includes('measurements'), true)
    assert.equal(xslist.supportedFields.includes('profile' as never), false)
    assert.equal(xslist.supportedFields.includes('bustCm' as never), false)
  })

  it('drops unknown actress supported field ids from packages', async () => {
    await importScraperPluginPackage(
      writePackage({
        ...pluginPackage('actress', 'Filtered Actress'),
        supportedFields: ['avatar', 'profile', 'measurements'] as unknown as ScraperPluginPackage['supportedFields']
      })
    )
    const plugin = listUserPluginDescriptors('actress').find((item) => item.name === 'Filtered Actress')
    assert.deepEqual(plugin?.supportedFields.sort(), ['avatar', 'measurements'].sort())
  })

  it('lists bundled plugins shipped with the app', () => {
    assert.deepEqual(
      listBundledPluginDescriptors('video').map((item) => item.name).sort(),
      ['JAV8', 'JavDB', 'JavLibrary']
    )
    assert.deepEqual(
      listBundledPluginDescriptors('actress').map((item) => item.name).sort(),
      ['Xslist', '偶像档案库']
    )
  })

  it('reads bundled plugin packages for export and AI debug', () => {
    const pkg = readScraperPluginPackage('video', 'JavDB')
    assert.equal(pkg.name, 'JavDB')
    assert.match(pkg.code, /parseVideo/)
    const exportPath = path.join(tempRoot!, 'bundled-export.avscraper.json')
    exportScraperPluginPackage('video', 'JavDB', exportPath)
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf-8')) as Record<string, unknown>
    assert.equal(exported.kind, 'video')
    assert.equal(exported.name, 'JavDB')
  })

  it('does not assign a standalone delay to composite scrapers', () => {
    createCompositeScraper('video', {
      name: 'Mixed Fields',
      fieldPluginMap: { title: 'JavDB', maker: 'JavLibrary' }
    })
    const composite = listCompositePluginDescriptors('video').find((item) => item.name === 'Mixed Fields')
    assert.equal(composite?.delay, undefined)
  })

  it('imports and executes a custom video plugin through the BaseScraper adapter', async () => {
    await importScraperPluginPackage(writePackage(pluginPackage('video', 'Example Video')))
    const scrapers = loadUserVideoScrapers()
    assert.equal(scrapers.length, 1)
    const result = await scrapers[0]!.parseTask('ABC-123')
    assert.deepEqual(result, { code: 'ABC-123', title: 'Plugin Title' })
  })

  it('normalizes video ratings to valid 5-point records only', () => {
    assert.deepEqual(
      normalizeVideoScrapeResult({ code: 'ABC-123', ratingAverage: 4.46, ratingCount: 12 }, 'ABC-123'),
      { code: 'ABC-123', ratingAverage: 4.5, ratingCount: 12 }
    )
    assert.deepEqual(
      normalizeVideoScrapeResult({ code: 'ABC-123', ratingAverage: 0, ratingCount: 12 }, 'ABC-123'),
      { code: 'ABC-123' }
    )
    assert.deepEqual(
      normalizeVideoScrapeResult({ code: 'ABC-123', ratingAverage: 9.2, ratingCount: 12 }, 'ABC-123'),
      { code: 'ABC-123' }
    )
  })

  it('reads an installed custom plugin package for AI debugging', async () => {
    const pkg = pluginPackage('video', 'Debug Video')
    await importScraperPluginPackage(writePackage(pkg))
    const loaded = readScraperPluginPackage('video', 'Debug Video')
    assert.equal(loaded.name, 'Debug Video')
    assert.equal(loaded.kind, 'video')
  })

  it('imports and executes a custom actress plugin through the BaseActressScraper adapter', async () => {
    await importScraperPluginPackage(writePackage(pluginPackage('actress', 'Example Actress')))
    const scrapers = loadUserActressScrapers()
    assert.equal(scrapers.length, 1)
    const result = await scrapers[0]!.parseTask('Alice', [])
    assert.deepEqual(result, { mainName: 'Alice', nameEn: 'Alice Example' })
  })

  it('allows a custom plugin to override a built-in name', async () => {
    await importScraperPluginPackage(writePackage(pluginPackage('video', 'JavDB')))
    const scrapers = loadUserVideoScrapers()
    assert.equal(scrapers.some((item) => item.scraperName === 'JavDB'), true)
  })

  it('lists only the custom plugin when it overrides a bundled name', async () => {
    const before = listMergedPluginDescriptors('video').filter((item) => item.name === 'JavDB')
    assert.equal(before.some((item) => item.source === 'builtin'), true)

    await importScraperPluginPackage(writePackage(pluginPackage('video', 'JavDB')))

    const after = listMergedPluginDescriptors('video').filter((item) => item.name === 'JavDB')
    assert.equal(after.length, 1)
    assert.equal(after[0]?.source, 'user')
    assert.equal(after[0]?.overridesBuiltIn, true)
  })

  it('rejects duplicate custom plugin names', async () => {
    await importScraperPluginPackage(writePackage(pluginPackage('video', 'Example Video')))

    await assert.rejects(
      importScraperPluginPackage(writePackage(pluginPackage('video', 'Example Video'))),
      /同名自定义插件/
    )
  })

  it('rejects plugin names that collide after filename sanitization', async () => {
    await importScraperPluginPackage(writePackage(pluginPackage('video', 'Example/Video')))

    await assert.rejects(
      importScraperPluginPackage(writePackage(pluginPackage('video', 'Example:Video'))),
      /安装目录相同/
    )
  })

  it('rejects packages without kind', async () => {
    const { kind: _kind, ...withoutKind } = pluginPackage('video', 'No Kind Field')
    await assert.rejects(importScraperPluginPackage(writePackage(withoutKind as ScraperPluginPackage)), /kind/)
  })

  it('exports packages with kind', async () => {
    await importScraperPluginPackage(writePackage(pluginPackage('video', 'Export Me')))
    const exportPath = path.join(tempRoot!, 'export.avscraper.json')
    exportScraperPluginPackage('video', 'Export Me', exportPath)
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf-8')) as Record<string, unknown>
    assert.equal(exported.kind, 'video')
    assert.equal(exported.name, 'Export Me')
    assert.equal(typeof exported.code, 'string')
    assert.deepEqual(readScraperPluginPackageForExport('video', 'Export Me'), exported)
  })
})
