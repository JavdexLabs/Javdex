import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { ScraperPluginKind } from '@shared/types'
import { BUNDLED_PLUGINS_ROOT_ENV } from '@shared/appIdentity'

export interface BundledPluginRecord {
  dir: string
  entryPath: string
  manifest: {
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
}

/** Root directory containing bundled plugin packages shipped with the app. */
export function bundledPluginsRoot(): string {
  if (process.env[BUNDLED_PLUGINS_ROOT_ENV]) {
    return process.env[BUNDLED_PLUGINS_ROOT_ENV]
  }
  let appPath = process.cwd()
  try {
    if (app?.getAppPath) appPath = app.getAppPath()
  } catch {
    /* Electron app may not be ready in tests. */
  }
  const candidates = [
    path.join(__dirname, 'bundled-plugins'),
    path.join(__dirname, '..', 'bundled-plugins'),
    path.join(appPath, 'bundled-plugins'),
    path.join(process.resourcesPath ?? '', 'bundled-plugins')
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return path.join(__dirname, 'bundled-plugins')
}

export function readBundledPluginRecords(kind: ScraperPluginKind): BundledPluginRecord[] {
  const root = path.join(bundledPluginsRoot(), kind)
  if (!fs.existsSync(root)) return []

  const plugins: BundledPluginRecord[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const manifestPath = path.join(dir, 'plugin.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BundledPluginRecord['manifest']
      if (parsed.kind !== kind || !parsed.name?.trim() || !parsed.entry?.trim()) continue
      const entryPath = path.join(dir, parsed.entry.trim())
      if (!fs.existsSync(entryPath)) continue
      plugins.push({
        dir,
        entryPath,
        manifest: {
          schemaVersion: 1,
          kind: parsed.kind,
          name: parsed.name.trim(),
          version: parsed.version?.trim() || '1.0.0',
          description: parsed.description?.trim() || '',
          author: parsed.author?.trim() || undefined,
          homepage: parsed.homepage?.trim() || undefined,
          supportedFields: Array.isArray(parsed.supportedFields) ? parsed.supportedFields : [],
          entry: parsed.entry.trim()
        }
      })
    } catch {
      /* Ignore malformed bundled plugin directories. */
    }
  }
  return plugins.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'zh-CN'))
}

export function findBundledPluginRecord(
  kind: ScraperPluginKind,
  name: string
): BundledPluginRecord | null {
  return readBundledPluginRecords(kind).find((item) => item.manifest.name === name) ?? null
}
