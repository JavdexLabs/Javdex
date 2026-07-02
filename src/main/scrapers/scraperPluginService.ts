import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  ActressScrapeResult,
  ALL_ACTRESS_SCRAPE_FIELDS,
  ALL_VIDEO_SCRAPE_FIELDS,
  expandActressScrapeFields,
  ScrapeResult,
  type ActressScrapeField,
  type CompositeScraperInput,
  type ScraperPluginDelay,
  ScraperPluginDescriptor,
  ScraperPluginKind,
  ScraperPluginPackage,
  type ScraperPluginUpdateInput,
  type VideoScrapeField,
  type ScraperPluginPackageExport,
  type ScraperPluginPackageImport
} from '@shared/types'
import type { BaseScraper } from './BaseScraper'
import type { BaseActressScraper } from './BaseActressScraper'
import {
  runUserActressPlugin,
  runUserVideoPlugin,
  validateUserPluginCode
} from './scraperPluginSandbox'
import { isBuiltInScraperName } from './builtInScraperNames'
import { findBundledPluginRecord, readBundledPluginRecords } from './bundledPlugins'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { readTestUserDataPath } from '@shared/appIdentity'

const PLUGIN_SCHEMA_VERSION = 1

interface StoredPluginManifest {
  schemaVersion: 1
  kind: ScraperPluginKind
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  supportedFields: string[]
  entry: string
}

class UserVideoScraper implements BaseScraper {
  scraperName: string

  constructor(
    private readonly manifest: StoredPluginManifest,
    private readonly entryPath: string
  ) {
    this.scraperName = manifest.name
  }

  async parseTask(code: string, proxyUrl?: string): Promise<ScrapeResult | null> {
    const pluginCode = fs.readFileSync(this.entryPath, 'utf-8')
    return runUserVideoPlugin(this.manifest.name, pluginCode, code, proxyUrl)
  }
}

class UserActressScraper implements BaseActressScraper {
  scraperName: string

  constructor(
    private readonly manifest: StoredPluginManifest,
    private readonly entryPath: string
  ) {
    this.scraperName = manifest.name
  }

  async parseTask(
    mainName: string,
    aliases: string[],
    proxyUrl?: string
  ): Promise<ActressScrapeResult | null> {
    const pluginCode = fs.readFileSync(this.entryPath, 'utf-8')
    return runUserActressPlugin(this.manifest.name, pluginCode, mainName, aliases, proxyUrl)
  }
}

export function builtInDescriptor(
  kind: ScraperPluginKind,
  name: string,
  description = ''
): ScraperPluginDescriptor {
  const bundled = findBundledPluginRecord(kind, name)
  if (bundled) return toBundledDescriptor(bundled.manifest)
  return {
    kind,
    name,
    version: '1.0.0',
    description,
    source: 'builtin',
    removable: false,
    exportable: true,
    editable: true,
    supportedFields: [...defaultSupportedFields(kind)],
    delay: delayForPlugin(kind, name)
  }
}

export function listBundledPluginDescriptors(kind: ScraperPluginKind): ScraperPluginDescriptor[] {
  return readBundledPluginRecords(kind).map(({ manifest }) => toBundledDescriptor(manifest))
}

export function loadBundledVideoScrapers(): BaseScraper[] {
  return readBundledPluginRecords('video').map(
    ({ manifest, entryPath }) => new UserVideoScraper(manifest as StoredPluginManifest, entryPath)
  )
}

export function loadBundledActressScrapers(): BaseActressScraper[] {
  return readBundledPluginRecords('actress').map(
    ({ manifest, entryPath }) => new UserActressScraper(manifest as StoredPluginManifest, entryPath)
  )
}

export function listUserPluginDescriptors(kind: ScraperPluginKind): ScraperPluginDescriptor[] {
  return readStoredPlugins(kind).map(({ manifest }) => toDescriptor(manifest))
}

export function loadUserVideoScrapers(): BaseScraper[] {
  return readStoredPlugins('video').map(
    ({ manifest, entryPath }) => new UserVideoScraper(manifest, entryPath)
  )
}

export function loadUserActressScrapers(): BaseActressScraper[] {
  return readStoredPlugins('actress').map(
    ({ manifest, entryPath }) => new UserActressScraper(manifest, entryPath)
  )
}

export async function importScraperPluginPackage(
  filePath: string
): Promise<ScraperPluginDescriptor> {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const pkg = JSON.parse(raw) as ScraperPluginPackageImport
  return installScraperPluginPackage(pkg)
}

export async function installScraperPluginPackage(
  pkg: ScraperPluginPackageImport,
  options: { overwriteUser?: boolean } = {}
): Promise<ScraperPluginDescriptor> {
  const normalized = normalizePackage(pkg)
  validatePluginNameAvailable(normalized.kind, normalized.name, options.overwriteUser)
  await validatePluginCode(normalized)

  const dir = pluginInstallDir(normalized.kind, normalized.name)
  if (options.overwriteUser && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  fs.mkdirSync(dir, { recursive: true })
  const manifest: StoredPluginManifest = {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    kind: normalized.kind,
    name: normalized.name,
    version: normalized.version ?? '1.0.0',
    description: normalized.description ?? '',
    author: normalized.author,
    homepage: normalized.homepage,
    supportedFields: normalizeSupportedFields(normalized.kind, normalized.supportedFields),
    entry: 'index.cjs'
  }
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  fs.writeFileSync(path.join(dir, manifest.entry), normalized.code, 'utf-8')
  return toDescriptor(manifest)
}

export function exportScraperPluginPackage(
  kind: ScraperPluginKind,
  name: string,
  targetPath: string
): void {
  fs.writeFileSync(
    targetPath,
    JSON.stringify(readScraperPluginPackageForExport(kind, name), null, 2),
    'utf-8'
  )
}

export function readScraperPluginPackageForExport(
  kind: ScraperPluginKind,
  name: string
): ScraperPluginPackageExport {
  const pkg = readScraperPluginPackage(kind, name)
  const exported: ScraperPluginPackageExport = {
    schemaVersion: pkg.schemaVersion,
    kind: pkg.kind,
    name: pkg.name,
    code: pkg.code
  }
  if (pkg.version) exported.version = pkg.version
  if (pkg.description) exported.description = pkg.description
  if (pkg.author) exported.author = pkg.author
  if (pkg.homepage) exported.homepage = pkg.homepage
  if (pkg.supportedFields?.length) exported.supportedFields = pkg.supportedFields
  return exported
}

export function readScraperPluginPackage(
  kind: ScraperPluginKind,
  name: string
): ScraperPluginPackage {
  const stored = findInstalledPlugin(kind, name)
  if (!stored) throw new Error('插件不存在')
  const code = fs.readFileSync(stored.entryPath, 'utf-8')
  const manifest = stored.manifest
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    kind: manifest.kind,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    supportedFields: normalizeSupportedFields(kind, manifest.supportedFields),
    code
  }
}

export function updateScraperPluginConfig(
  kind: ScraperPluginKind,
  name: string,
  input: ScraperPluginUpdateInput
): ScraperPluginDescriptor {
  const stored = findStoredPlugin(kind, name)
  if (stored) {
    const manifest: StoredPluginManifest = {
      ...stored.manifest,
      version: input.version?.trim() || stored.manifest.version,
      description:
        input.description !== undefined ? input.description.trim() : stored.manifest.description,
      author: input.author !== undefined ? input.author.trim() || undefined : stored.manifest.author,
      homepage:
        input.homepage !== undefined ? input.homepage.trim() || undefined : stored.manifest.homepage,
      supportedFields:
        input.supportedFields !== undefined
          ? normalizeSupportedFields(kind, input.supportedFields)
          : stored.manifest.supportedFields
    }
    fs.writeFileSync(path.join(stored.dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    if (input.delay) updatePluginDelay(kind, name, input.delay)
    return toDescriptor(manifest)
  }

  if (!isBuiltInScraperName(kind, name) && !findBundledPluginRecord(kind, name)) {
    throw new Error('插件不存在')
  }
  if (input.delay) updatePluginDelay(kind, name, input.delay)
  return builtInDescriptor(kind, name)
}

export function deleteScraperPlugin(kind: ScraperPluginKind, name: string): boolean {
  const stored = findStoredPlugin(kind, name)
  if (!stored) throw new Error('只能删除已导入的自定义插件')
  fs.rmSync(stored.dir, { recursive: true, force: true })
  return true
}

export function createCompositeScraper(
  kind: ScraperPluginKind,
  input: CompositeScraperInput
): ScraperPluginDescriptor {
  const name = input.name.trim()
  if (!name) throw new Error('组合插件名称不能为空')
  if (isBuiltInScraperName(kind, name) || findStoredPlugin(kind, name)) {
    throw new Error('组合插件名称不能和已有插件重名')
  }

  const settings = getSettings()
  const current = settings.compositeScrapers[kind]
  if (current.some((item) => item.name === name)) {
    throw new Error('已存在同名组合插件')
  }
  const normalized = {
    kind,
    name,
    description: input.description?.trim() || undefined,
    fieldPluginMap: normalizeCompositeFieldMap(kind, input.fieldPluginMap)
  }
  updateSettings({
    compositeScrapers: {
      ...settings.compositeScrapers,
      [kind]: [...current, normalized]
    }
  })
  return compositeDescriptor(normalized)
}

export function updateCompositeScraper(
  kind: ScraperPluginKind,
  name: string,
  input: CompositeScraperInput
): ScraperPluginDescriptor {
  const nextName = input.name.trim()
  if (!nextName) throw new Error('组合插件名称不能为空')
  const settings = getSettings()
  const current = settings.compositeScrapers[kind]
  const index = current.findIndex((item) => item.name === name)
  if (index < 0) throw new Error('组合插件不存在')
  if (
    nextName !== name &&
    (isBuiltInScraperName(kind, nextName) ||
      findStoredPlugin(kind, nextName) ||
      current.some((item) => item.name === nextName))
  ) {
    throw new Error('组合插件名称不能和已有插件重名')
  }
  const normalized = {
    kind,
    name: nextName,
    description: input.description?.trim() || undefined,
    fieldPluginMap: normalizeCompositeFieldMap(kind, input.fieldPluginMap)
  }
  const updated = [...current]
  updated[index] = normalized
  updateSettings({
    compositeScrapers: {
      ...settings.compositeScrapers,
      [kind]: updated
    }
  })
  return compositeDescriptor(normalized)
}

export function deleteCompositeScraper(kind: ScraperPluginKind, name: string): boolean {
  const settings = getSettings()
  const current = settings.compositeScrapers[kind]
  const next = current.filter((item) => item.name !== name)
  if (next.length === current.length) throw new Error('组合插件不存在')
  updateSettings({
    compositeScrapers: {
      ...settings.compositeScrapers,
      [kind]: next
    }
  })
  return true
}

export function pluginPackageDefaultName(kind: ScraperPluginKind, name: string): string {
  return `${sanitizeFileName(name || `${kind}-scraper`)}.${kind}.avscraper.json`
}

function readStoredPlugins(kind: ScraperPluginKind): {
  manifest: StoredPluginManifest
  dir: string
  entryPath: string
}[] {
  const root = pluginsRoot(kind)
  if (!fs.existsSync(root)) return []
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const plugins: { manifest: StoredPluginManifest; dir: string; entryPath: string }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    try {
      const manifest = readManifest(path.join(dir, 'plugin.json'))
      if (manifest.kind !== kind) continue
      const entryPath = path.join(dir, manifest.entry)
      if (!fs.existsSync(entryPath)) continue
      plugins.push({ manifest, dir, entryPath })
    } catch {
      /* Ignore malformed plugin directories; import performs strict validation. */
    }
  }
  return plugins.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

function findInstalledPlugin(
  kind: ScraperPluginKind,
  name: string
): { manifest: StoredPluginManifest; dir: string; entryPath: string } | null {
  return findStoredPlugin(kind, name) ?? findBundledPlugin(kind, name)
}

function findBundledPlugin(
  kind: ScraperPluginKind,
  name: string
): { manifest: StoredPluginManifest; dir: string; entryPath: string } | null {
  const bundled = findBundledPluginRecord(kind, name)
  if (!bundled) return null
  return {
    manifest: {
      ...bundled.manifest,
      supportedFields: normalizeSupportedFields(kind, bundled.manifest.supportedFields)
    },
    dir: bundled.dir,
    entryPath: bundled.entryPath
  }
}

function toBundledDescriptor(manifest: StoredPluginManifest): ScraperPluginDescriptor {
  return {
    kind: manifest.kind,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    source: 'builtin',
    removable: false,
    exportable: true,
    editable: true,
    supportedFields: [...normalizeSupportedFields(manifest.kind, manifest.supportedFields)],
    delay: delayForPlugin(manifest.kind, manifest.name)
  }
}

function findStoredPlugin(
  kind: ScraperPluginKind,
  name: string
): { manifest: StoredPluginManifest; dir: string; entryPath: string } | null {
  return readStoredPlugins(kind).find((p) => p.manifest.name === name) ?? null
}

function readManifest(filePath: string): StoredPluginManifest {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<StoredPluginManifest>
  if (parsed.schemaVersion !== PLUGIN_SCHEMA_VERSION) throw new Error('Unsupported plugin schema')
  if (parsed.kind !== 'video' && parsed.kind !== 'actress') throw new Error('Invalid plugin kind')
  if (!parsed.name?.trim()) throw new Error('Plugin name is required')
  if (!parsed.entry?.trim()) throw new Error('Plugin entry is required')
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    kind: parsed.kind,
    name: parsed.name.trim(),
    version: parsed.version?.trim() || '1.0.0',
    description: parsed.description?.trim() || '',
    author: parsed.author?.trim() || undefined,
      homepage: parsed.homepage?.trim() || undefined,
      supportedFields: normalizeSupportedFields(parsed.kind, parsed.supportedFields),
      entry: parsed.entry.trim()
  }
}

function normalizePackage(pkg: ScraperPluginPackageImport): ScraperPluginPackage {
  if (pkg.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    throw new Error('插件包 schemaVersion 必须为 1')
  }
  if (pkg.kind !== 'video' && pkg.kind !== 'actress') {
    throw new Error('插件包 kind 必须为 video 或 actress')
  }
  if (!pkg.name?.trim()) throw new Error('插件包缺少 name')
  if (!pkg.code?.trim()) throw new Error('插件包缺少 code')
  const kind = pkg.kind
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    kind,
    name: pkg.name.trim(),
    version: pkg.version?.trim() || '1.0.0',
    description: pkg.description?.trim() || '',
    author: pkg.author?.trim() || undefined,
    homepage: pkg.homepage?.trim() || undefined,
    supportedFields: normalizeSupportedFields(kind, pkg.supportedFields),
    code: pkg.code
  }
}

function validatePluginNameAvailable(
  kind: ScraperPluginKind,
  name: string,
  overwriteUser = false
): void {
  if (findStoredPlugin(kind, name)) {
    if (overwriteUser) return
    throw new Error('已存在同名自定义插件')
  }
  const dir = pluginInstallDir(kind, name)
  if (fs.existsSync(dir)) {
    if (overwriteUser) return
    throw new Error('已存在安装目录相同的自定义插件')
  }
}

function validatePluginCode(pkg: ScraperPluginPackage): Promise<void> {
  return validateUserPluginCode(pkg.kind, pkg.name, pkg.code)
}

function toDescriptor(manifest: StoredPluginManifest): ScraperPluginDescriptor {
  return {
    kind: manifest.kind,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    source: 'user',
    removable: true,
    exportable: true,
    editable: true,
    overridesBuiltIn: isBuiltInScraperName(manifest.kind, manifest.name),
    supportedFields: normalizeSupportedFields(manifest.kind, manifest.supportedFields),
    delay: delayForPlugin(manifest.kind, manifest.name)
  }
}

function compositeDescriptor(definition: {
  kind: ScraperPluginKind
  name: string
  description?: string
  fieldPluginMap: Partial<Record<VideoScrapeField | ActressScrapeField, string>>
}): ScraperPluginDescriptor {
  return {
    kind: definition.kind,
    name: definition.name,
    version: '组合',
    description: definition.description ?? '',
    source: 'composite',
    removable: true,
    exportable: false,
    editable: true,
    supportedFields: Object.keys(definition.fieldPluginMap) as Array<
      VideoScrapeField | ActressScrapeField
    >,
    fieldPluginMap: definition.fieldPluginMap
  }
}

export function listCompositePluginDescriptors(kind: ScraperPluginKind): ScraperPluginDescriptor[] {
  return getSettings().compositeScrapers[kind].map(compositeDescriptor)
}

/** Bundled plugins hidden when a user install overrides the same name. */
export function listMergedPluginDescriptors(kind: ScraperPluginKind): ScraperPluginDescriptor[] {
  const bundled = listBundledPluginDescriptors(kind)
  const user = listUserPluginDescriptors(kind)
  const overriddenNames = new Set(
    user.filter((plugin) => plugin.overridesBuiltIn).map((plugin) => plugin.name)
  )
  const visibleBundled = bundled.filter((plugin) => !overriddenNames.has(plugin.name))
  return [...visibleBundled, ...user, ...listCompositePluginDescriptors(kind)]
}

export function findCompositeScraper(
  kind: ScraperPluginKind,
  name: string
): { name: string; fieldPluginMap: Partial<Record<VideoScrapeField | ActressScrapeField, string>> } | null {
  return getSettings().compositeScrapers[kind].find((item) => item.name === name) ?? null
}

export function defaultSupportedFields(
  kind: ScraperPluginKind
): Array<VideoScrapeField | ActressScrapeField> {
  return kind === 'video' ? ALL_VIDEO_SCRAPE_FIELDS : ALL_ACTRESS_SCRAPE_FIELDS
}

function normalizeSupportedFields(
  kind: ScraperPluginKind,
  fields: unknown
): Array<VideoScrapeField | ActressScrapeField> {
  const allowed = new Set(defaultSupportedFields(kind))
  if (!Array.isArray(fields) || fields.length === 0) return [...allowed]
  const normalized =
    kind === 'actress'
      ? expandActressScrapeFields(fields.filter((field): field is string => typeof field === 'string'))
      : fields.filter((field): field is string => typeof field === 'string')
  const out: Array<VideoScrapeField | ActressScrapeField> = []
  const seen = new Set<string>()
  for (const field of normalized) {
    if (!allowed.has(field as never) || seen.has(field)) continue
    seen.add(field)
    out.push(field as VideoScrapeField | ActressScrapeField)
  }
  return out.length > 0 ? out : [...allowed]
}

function normalizeCompositeFieldMap(
  kind: ScraperPluginKind,
  fieldPluginMap: CompositeScraperInput['fieldPluginMap']
): CompositeScraperInput['fieldPluginMap'] {
  const allowed = new Set(defaultSupportedFields(kind))
  const out: CompositeScraperInput['fieldPluginMap'] = {}
  for (const [field, pluginName] of Object.entries(fieldPluginMap)) {
    if (typeof pluginName !== 'string' || !pluginName.trim()) continue
    const mappedFields =
      kind === 'actress' ? expandActressScrapeFields([field]) : allowed.has(field as never) ? [field] : []
    for (const mappedField of mappedFields) {
      if (!allowed.has(mappedField as never)) continue
      out[mappedField as VideoScrapeField | ActressScrapeField] = pluginName.trim()
    }
  }
  if (Object.keys(out).length === 0) throw new Error('组合插件至少需要配置一个字段')
  return out
}

function delayForPlugin(kind: ScraperPluginKind, name: string): ScraperPluginDelay {
  const settings = getSettings()
  return (
    settings.scraperPluginDelays[kind][name] ?? {
      minMs: settings.batchDelayMinMs,
      maxMs: settings.batchDelayMaxMs
    }
  )
}

function updatePluginDelay(kind: ScraperPluginKind, name: string, delay: ScraperPluginDelay): void {
  const settings = getSettings()
  const minMs = Math.max(0, Math.round(delay.minMs))
  const maxMs = Math.max(minMs, Math.round(delay.maxMs))
  updateSettings({
    scraperPluginDelays: {
      ...settings.scraperPluginDelays,
      [kind]: {
        ...settings.scraperPluginDelays[kind],
        [name]: { minMs, maxMs }
      }
    }
  })
}

function pluginsRoot(kind: ScraperPluginKind): string {
  return path.join(getUserDataPath(), 'scraper_plugins', kind)
}

function getUserDataPath(): string {
  if (app?.getPath) return app.getPath('userData')
  const fallback = readTestUserDataPath()
  if (fallback) return fallback
  throw new Error('Electron app userData path is unavailable')
}

function pluginInstallDir(kind: ScraperPluginKind, name: string): string {
  return path.join(pluginsRoot(kind), sanitizeFileName(name))
}

function sanitizeFileName(input: string): string {
  const cleaned = input.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_')
  return cleaned.slice(0, 80) || 'scraper_plugin'
}
