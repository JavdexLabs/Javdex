import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ActressScrapeResult, ALL_ACTRESS_SCRAPE_FIELDS, ALL_VIDEO_SCRAPE_FIELDS, expandActressScrapeFields, ScraperPluginDescriptor, ScraperPluginKind, ScraperPluginPackage, type ActressScrapeField, type CompositeScraperInput, type ScraperPluginDelay, type ScraperPluginUpdateInput, type VideoScrapeField, type ScraperPluginPackageExport, type ScraperPluginPackageImport } from '@shared/scrapeTypes'
import type { VideoPluginScrapeResult } from '@shared/videoScrapeTypes'
import type { ScraperServiceId } from '@shared/scraperServiceTypes'
import type { BaseScraper } from './BaseScraper'
import type { BaseActressScraper } from './BaseActressScraper'
import {
  runUserActressPlugin,
  runUserVideoPlugin,
  validateUserPluginCode
} from './scraperPluginSandbox'
import { isBuiltInScraperName } from './builtInScraperNames'
import { findBundledPluginRecord, readBundledPluginRecords } from './bundledPlugins'
import {
  getSettings,
  migrateRetiredVideoScraperSettings,
  updateSettings
} from '../settings/settingsStore'
import { readTestUserDataPath } from '@shared/appIdentity'
import {
  getScraperServicePublicConfig,
  isScraperServiceConfigured
} from './configuredScraperService'

const PLUGIN_SCHEMA_VERSION = 1
const RETIRED_PLUGIN_NAMES: Partial<Record<ScraperPluginKind, readonly string[]>> = {
  video: ['JAV8']
}
const PLUGIN_DEFAULT_DELAYS: Partial<
  Record<ScraperPluginKind, Record<string, ScraperPluginDelay>>
> = {
  actress: {
    Gfriends: { minMs: 0, maxMs: 0 }
  }
}

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
  serviceBinding?: ScraperServiceId
}

class UserVideoScraper implements BaseScraper {
  scraperName: string

  constructor(
    private readonly manifest: StoredPluginManifest,
    private readonly entryPath: string
  ) {
    this.scraperName = manifest.name
  }

  async parseTask(code: string, proxyUrl?: string): Promise<VideoPluginScrapeResult> {
    const pluginCode = fs.readFileSync(this.entryPath, 'utf-8')
    return runUserVideoPlugin(
      this.manifest.name,
      pluginCode,
      code,
      proxyUrl,
      this.manifest.serviceBinding
    )
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
    debuggable: true,
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

/**
 * Older builds allowed user plugins to override built-in names. Rename those
 * installs to `{name}-custom` (or `-custom-N`) and remap settings references.
 * Safe to call repeatedly.
 */
export function migrateUserPluginsAwayFromBuiltInNames(): void {
  const renames: Array<{ kind: ScraperPluginKind; from: string; to: string }> = []
  for (const kind of ['video', 'actress'] as const) {
    renames.push(...migrateConflictingUserPluginsForKind(kind))
  }
  if (renames.length > 0) {
    remapSettingsPluginNames(renames)
  }
  migrateRetiredVideoScraperSettings()
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
  const parent = path.dirname(dir)
  const token = randomUUID()
  const staging = path.join(parent, `.${path.basename(dir)}.install-${token}`)
  const backup = path.join(parent, `.${path.basename(dir)}.backup-${token}`)
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
  fs.mkdirSync(staging, { recursive: true })
  try {
    fs.writeFileSync(path.join(staging, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    fs.writeFileSync(path.join(staging, manifest.entry), normalized.code, 'utf-8')
    const replacing = options.overwriteUser === true && fs.existsSync(dir)
    if (replacing) fs.renameSync(dir, backup)
    try {
      fs.renameSync(staging, dir)
    } catch (error) {
      if (replacing && fs.existsSync(backup) && !fs.existsSync(dir)) fs.renameSync(backup, dir)
      throw error
    }
    if (replacing && fs.existsSync(backup)) {
      try {
        fs.rmSync(backup, { recursive: true, force: true })
      } catch {
        // The new directory is already committed. A leftover hidden backup is safer than
        // reporting a failed install after the visible plugin has actually changed.
      }
    }
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
  }
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
  if (stored.manifest.serviceBinding) {
    throw new Error('受信服务内置插件不可导出、读取代码或进行 AI 调试')
  }
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
  if (
    isReservedBuiltInPluginName(kind, name) ||
    findStoredPlugin(kind, name)
  ) {
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
  assertCompositeSourcesRunnable(kind, normalized.fieldPluginMap)
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
    (isReservedBuiltInPluginName(kind, nextName) ||
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
  assertCompositeSourcesRunnable(kind, normalized.fieldPluginMap)
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
  // Lazily migrate legacy same-name overrides before any listing/load path.
  migrateUserPluginsAwayFromBuiltInNames()
  return readStoredPluginsRaw(kind)
}

function readStoredPluginsRaw(kind: ScraperPluginKind): {
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

function suggestCustomSuffixPluginName(baseName: string, takenNames: Set<string>): string {
  const base = baseName.trim() || 'plugin'
  const candidates = [`${base}-custom`]
  for (const candidate of candidates) {
    if (!takenNames.has(candidate)) return candidate
  }
  let index = 2
  while (takenNames.has(`${base}-custom-${index}`)) index += 1
  return `${base}-custom-${index}`
}

function migrateConflictingUserPluginsForKind(
  kind: ScraperPluginKind
): Array<{ kind: ScraperPluginKind; from: string; to: string }> {
  const plugins = readStoredPluginsRaw(kind)
  const taken = new Set(plugins.map((plugin) => plugin.manifest.name))
  const renames: Array<{ kind: ScraperPluginKind; from: string; to: string }> = []

  for (const plugin of plugins) {
    const from = plugin.manifest.name
    if (!isReservedBuiltInPluginName(kind, from)) continue

    let to = suggestCustomSuffixPluginName(from, taken)
    while (fs.existsSync(pluginInstallDir(kind, to))) {
      taken.add(to)
      to = suggestCustomSuffixPluginName(from, taken)
    }

    renameStoredPlugin(plugin, to)
    taken.delete(from)
    taken.add(to)
    renames.push({ kind, from, to })
  }

  return renames
}

function renameStoredPlugin(
  plugin: { manifest: StoredPluginManifest; dir: string; entryPath: string },
  nextName: string
): void {
  const nextManifest: StoredPluginManifest = {
    ...plugin.manifest,
    name: nextName
  }
  const targetDir = pluginInstallDir(plugin.manifest.kind, nextName)
  const manifestPath = path.join(plugin.dir, 'plugin.json')
  fs.writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf-8')

  if (path.resolve(plugin.dir) !== path.resolve(targetDir)) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true })
    fs.renameSync(plugin.dir, targetDir)
  }
}

function remapSettingsPluginNames(
  renames: Array<{ kind: ScraperPluginKind; from: string; to: string }>
): void {
  if (renames.length === 0) return
  const settings = getSettings()
  const videoMap = new Map(
    renames.filter((item) => item.kind === 'video').map((item) => [item.from, item.to])
  )
  const actressMap = new Map(
    renames.filter((item) => item.kind === 'actress').map((item) => [item.from, item.to])
  )

  const mapName = (kind: ScraperPluginKind, name: string): string => {
    const mapped = kind === 'video' ? videoMap.get(name) : actressMap.get(name)
    return mapped ?? name
  }

  const nextDelays = {
    video: { ...settings.scraperPluginDelays.video },
    actress: { ...settings.scraperPluginDelays.actress }
  }
  for (const { kind, from, to } of renames) {
    const bucket = nextDelays[kind]
    if (Object.prototype.hasOwnProperty.call(bucket, from)) {
      if (!Object.prototype.hasOwnProperty.call(bucket, to)) {
        bucket[to] = bucket[from]!
      }
      delete bucket[from]
    }
  }

  const nextComposites = {
    video: settings.compositeScrapers.video.map((item) => ({
      ...item,
      fieldPluginMap: Object.fromEntries(
        Object.entries(item.fieldPluginMap).map(([field, pluginName]) => [
          field,
          mapName('video', pluginName)
        ])
      ) as typeof item.fieldPluginMap
    })),
    actress: settings.compositeScrapers.actress.map((item) => ({
      ...item,
      fieldPluginMap: Object.fromEntries(
        Object.entries(item.fieldPluginMap).map(([field, pluginName]) => [
          field,
          mapName('actress', pluginName)
        ])
      ) as typeof item.fieldPluginMap
    }))
  }

  updateSettings({
    defaultScraper: mapName('video', settings.defaultScraper),
    defaultActressScraper: mapName('actress', settings.defaultActressScraper),
    scraperPluginDelays: nextDelays,
    compositeScrapers: nextComposites
  })
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
  const requiresConfiguration = Boolean(manifest.serviceBinding)
  const configured = manifest.serviceBinding
    ? isScraperServiceConfigured(manifest.serviceBinding)
    : true
  const publicConfig = manifest.serviceBinding
    ? getScraperServicePublicConfig(manifest.serviceBinding)
    : null
  const configurationLabel = publicConfig?.serverUrl
    ? `${new URL(publicConfig.serverUrl).host} · Token ${publicConfig.hasToken ? '已设置' : '未设置'}`
    : requiresConfiguration
      ? '待配置'
      : undefined
  return {
    kind: manifest.kind,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    source: 'builtin',
    removable: false,
    exportable: !requiresConfiguration,
    editable: !requiresConfiguration,
    debuggable: !requiresConfiguration,
    requiresConfiguration,
    configured,
    configurationLabel,
    disabledReason: configured ? undefined : '请先配置 MetaTube 服务端地址',
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
  if (parsed.serviceBinding !== undefined) {
    throw new Error('User plugins cannot declare a trusted service binding')
  }
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
  if ((pkg as ScraperPluginPackageImport & { serviceBinding?: unknown }).serviceBinding !== undefined) {
    throw new Error('用户导入包不能声明受信服务绑定')
  }
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

function isReservedBuiltInPluginName(kind: ScraperPluginKind, name: string): boolean {
  return (
    isBuiltInScraperName(kind, name) ||
    RETIRED_PLUGIN_NAMES[kind]?.includes(name) === true ||
    Boolean(findBundledPluginRecord(kind, name))
  )
}

function validatePluginNameAvailable(
  kind: ScraperPluginKind,
  name: string,
  overwriteUser = false
): void {
  if (isReservedBuiltInPluginName(kind, name)) {
    throw new Error('不能与内置插件同名；请改用新名称安装为自定义插件')
  }
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
    debuggable: true,
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
  const standalone = standalonePluginDescriptors(definition.kind)
  const unavailable = Array.from(new Set(Object.values(definition.fieldPluginMap)))
    .filter((name): name is string => Boolean(name))
    .find((name) => standalone.find((plugin) => plugin.name === name)?.configured === false)
  const missing = Array.from(new Set(Object.values(definition.fieldPluginMap)))
    .filter((name): name is string => Boolean(name))
    .find((name) => !standalone.some((plugin) => plugin.name === name))
  const configured = !unavailable && !missing
  return {
    kind: definition.kind,
    name: definition.name,
    version: '组合',
    description: definition.description ?? '',
    source: 'composite',
    removable: true,
    exportable: false,
    editable: true,
    debuggable: false,
    configured,
    disabledReason: unavailable
      ? `字段源「${unavailable}」尚未配置`
      : missing
        ? `字段源「${missing}」不存在`
        : undefined,
    supportedFields: Object.keys(definition.fieldPluginMap) as Array<
      VideoScrapeField | ActressScrapeField
    >,
    fieldPluginMap: definition.fieldPluginMap
  }
}

function standalonePluginDescriptors(kind: ScraperPluginKind): ScraperPluginDescriptor[] {
  return [...listBundledPluginDescriptors(kind), ...listUserPluginDescriptors(kind)]
}

function assertCompositeSourcesRunnable(
  kind: ScraperPluginKind,
  fieldPluginMap: CompositeScraperInput['fieldPluginMap']
): void {
  const standalone = standalonePluginDescriptors(kind)
  for (const pluginName of new Set(Object.values(fieldPluginMap))) {
    if (!pluginName) continue
    const descriptor = standalone.find((plugin) => plugin.name === pluginName)
    if (!descriptor) throw new Error(`组合字段源「${pluginName}」不存在`)
    if (descriptor.configured === false) {
      throw new Error(descriptor.disabledReason ?? `组合字段源「${pluginName}」尚未配置`)
    }
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

export function isScraperPluginRunnable(kind: ScraperPluginKind, name: string): boolean {
  const descriptor = listMergedPluginDescriptors(kind).find((plugin) => plugin.name === name)
  return Boolean(descriptor && descriptor.configured !== false)
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

export function normalizeSupportedFields(
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
    settings.scraperPluginDelays[kind][name] ??
    PLUGIN_DEFAULT_DELAYS[kind]?.[name] ?? {
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
