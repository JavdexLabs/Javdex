import { app, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import { createHttpClient } from '../utils/http'
import { getSettings } from '../settings/settingsStore'
import { resolveScrapeProxyUrl } from '@shared/types'
import type {
  AppReleaseInfo,
  UpdateCheckErrorCode,
  UpdateCheckState
} from '@shared/updateTypes'

const RELEASES_API_URL = 'https://api.github.com/repos/JavdexLabs/Javdex/releases/latest'
const RELEASE_URL_PREFIX = 'https://github.com/JavdexLabs/Javdex/releases/'
const PROJECT_URLS = {
  project: 'https://github.com/JavdexLabs/Javdex',
  releases: 'https://github.com/JavdexLabs/Javdex/releases',
  license: 'https://github.com/JavdexLabs/Javdex/blob/main/LICENSE'
} as const
export type ProjectPage = keyof typeof PROJECT_URLS
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_RELEASE_NOTES_LENGTH = 20_000
const MAX_RELEASE_NAME_LENGTH = 200
const MAX_EXTERNAL_URL_LENGTH = 2_048

interface PersistedUpdateState {
  lastCheckedAt?: string
  ignoredVersion?: string
  cachedRelease?: AppReleaseInfo
}

interface GitHubReleaseResponse {
  tag_name?: unknown
  name?: unknown
  html_url?: unknown
  published_at?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
}

let runtimeState: UpdateCheckState | null = null
let checkPromise: Promise<UpdateCheckState> | null = null
const listeners = new Set<(state: UpdateCheckState) => void>()

function stateFilePath(): string {
  return path.join(app.getPath('userData'), 'update-state.json')
}

function readPersistedState(): PersistedUpdateState {
  try {
    return normalizePersistedUpdateState(JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')))
  } catch {
    return {}
  }
}

export function normalizePersistedUpdateState(value: unknown): PersistedUpdateState {
  if (!value || typeof value !== 'object') return {}
  const input = value as Record<string, unknown>
  const lastCheckedAt =
    typeof input.lastCheckedAt === 'string' && Number.isFinite(Date.parse(input.lastCheckedAt))
      ? input.lastCheckedAt
      : undefined
  const ignoredVersion =
    typeof input.ignoredVersion === 'string' && parseReleaseVersion(input.ignoredVersion)
      ? input.ignoredVersion.replace(/^v/, '')
      : undefined
  const cached = input.cachedRelease
  let cachedRelease: AppReleaseInfo | undefined
  if (cached && typeof cached === 'object') {
    const release = cached as Record<string, unknown>
    if (
      typeof release.version === 'string' &&
      typeof release.tagName === 'string' &&
      typeof release.releaseName === 'string' &&
      typeof release.releaseUrl === 'string' &&
      (release.publishedAt === null || typeof release.publishedAt === 'string') &&
      typeof release.releaseNotes === 'string'
    ) {
      const normalized = normalizeGitHubRelease({
        tag_name: release.tagName,
        name: release.releaseName,
        html_url: release.releaseUrl,
        published_at: release.publishedAt,
        body: release.releaseNotes,
        draft: false,
        prerelease: false
      })
      if (normalized?.version === release.version) cachedRelease = normalized
    }
  }
  return {
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(ignoredVersion ? { ignoredVersion } : {}),
    ...(cachedRelease ? { cachedRelease } : {})
  }
}

function writePersistedState(state: PersistedUpdateState): void {
  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.error('Failed to persist update check state:', error)
  }
}

export function parseReleaseVersion(input: unknown): [number, number, number] | null {
  if (typeof input !== 'string') return null
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  const parts = match.slice(1).map(Number) as [number, number, number]
  return parts.every(Number.isSafeInteger) ? parts : null
}

export function compareReleaseVersions(left: string, right: string): number | null {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function isTrustedReleaseUrl(value: string): boolean {
  if (value.length > MAX_EXTERNAL_URL_LENGTH) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && value.startsWith(RELEASE_URL_PREFIX)
  } catch {
    return false
  }
}

export function normalizeGitHubRelease(value: GitHubReleaseResponse): AppReleaseInfo | null {
  if (value.draft !== false || value.prerelease !== false) return null
  if (typeof value.tag_name !== 'string' || !parseReleaseVersion(value.tag_name)) return null
  if (typeof value.html_url !== 'string' || !isTrustedReleaseUrl(value.html_url)) return null
  if (value.published_at !== null && typeof value.published_at !== 'string') return null
  const version = value.tag_name.replace(/^v/, '')
  return {
    version,
    tagName: value.tag_name,
    releaseName:
      typeof value.name === 'string' && value.name.trim()
        ? value.name.trim().slice(0, MAX_RELEASE_NAME_LENGTH)
        : `Javdex ${value.tag_name}`,
    releaseUrl: value.html_url,
    publishedAt: value.published_at ?? null,
    releaseNotes:
      typeof value.body === 'string' ? value.body.slice(0, MAX_RELEASE_NOTES_LENGTH) : ''
  }
}

function buildState(persisted = readPersistedState()): UpdateCheckState {
  const currentVersion = app.getVersion()
  const comparison = persisted.cachedRelease
    ? compareReleaseVersions(persisted.cachedRelease.version, currentVersion)
    : null
  return {
    status: comparison !== null && comparison > 0 ? 'available' : 'idle',
    currentVersion,
    ...(persisted.cachedRelease ? { latestRelease: persisted.cachedRelease } : {}),
    ...(persisted.lastCheckedAt ? { checkedAt: persisted.lastCheckedAt } : {}),
    ...(persisted.ignoredVersion ? { ignoredVersion: persisted.ignoredVersion } : {})
  }
}

function publish(state: UpdateCheckState): UpdateCheckState {
  runtimeState = state
  listeners.forEach((listener) => listener(state))
  return state
}

export function getUpdateCheckState(): UpdateCheckState {
  if (!runtimeState) runtimeState = buildState()
  return runtimeState
}

function mapCheckError(error: unknown): UpdateCheckErrorCode {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 403 || error.response?.status === 429) return 'rate-limited'
    if (error.response?.status === 404) return 'repository-unavailable'
    if (!error.response) return 'network-unavailable'
  }
  return 'unknown'
}

export async function checkForLatestRelease(): Promise<UpdateCheckState> {
  if (checkPromise) return checkPromise
  checkPromise = (async () => {
    const previous = getUpdateCheckState()
    publish({ ...previous, status: 'checking', errorCode: undefined })
    try {
      const proxyUrl = resolveScrapeProxyUrl(getSettings())
      const client = createHttpClient(proxyUrl)
      const response = await client.get<GitHubReleaseResponse>(RELEASES_API_URL, {
        timeout: 10_000,
        maxContentLength: 256 * 1024,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Javdex/${app.getVersion()}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      })
      const release = normalizeGitHubRelease(response.data)
      if (!release) throw new Error('INVALID_RELEASE_RESPONSE')
      const comparison = compareReleaseVersions(release.version, app.getVersion())
      if (comparison === null) throw new Error('INVALID_RELEASE_VERSION')
      const checkedAt = new Date().toISOString()
      const persisted = readPersistedState()
      writePersistedState({ ...persisted, lastCheckedAt: checkedAt, cachedRelease: release })
      return publish({
        status: comparison > 0 ? 'available' : 'up-to-date',
        currentVersion: app.getVersion(),
        latestRelease: release,
        checkedAt,
        ...(persisted.ignoredVersion ? { ignoredVersion: persisted.ignoredVersion } : {})
      })
    } catch (error) {
      const errorCode =
        error instanceof Error && error.message.startsWith('INVALID_')
          ? 'invalid-response'
          : mapCheckError(error)
      return publish({ ...previous, status: 'error', errorCode })
    } finally {
      checkPromise = null
    }
  })()
  return checkPromise
}

export async function openReleasePage(): Promise<boolean> {
  const release = getUpdateCheckState().latestRelease
  if (!release || !isTrustedReleaseUrl(release.releaseUrl)) return false
  await shell.openExternal(release.releaseUrl)
  return true
}

export async function openProjectPage(page: ProjectPage): Promise<boolean> {
  const url = PROJECT_URLS[page]
  if (!url) return false
  await shell.openExternal(url)
  return true
}

export async function openExternalReleaseLink(rawUrl: string): Promise<boolean> {
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_EXTERNAL_URL_LENGTH) return false
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:') return false
    await shell.openExternal(url.toString())
    return true
  } catch {
    return false
  }
}

export function ignoreUpdateVersion(version: string): UpdateCheckState {
  const release = getUpdateCheckState().latestRelease
  if (!release || release.version !== version) return getUpdateCheckState()
  const persisted = readPersistedState()
  writePersistedState({ ...persisted, ignoredVersion: version })
  return publish({ ...getUpdateCheckState(), ignoredVersion: version })
}

export function shouldRunAutomaticCheck(now = Date.now()): boolean {
  const checkedAt = readPersistedState().lastCheckedAt
  if (!checkedAt) return true
  const timestamp = Date.parse(checkedAt)
  return !Number.isFinite(timestamp) || now - timestamp >= AUTO_CHECK_INTERVAL_MS
}

export function onUpdateCheckStateChanged(
  listener: (state: UpdateCheckState) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
