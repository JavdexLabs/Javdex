import { app } from 'electron'

export interface ScrapeUaProfile {
  userAgent: string
  major: string
  fullVersion: string
  platform: string
  secChUaPlatform: string
  platformVersion: string
  architecture: string
  bitness: string
}

let cachedUaProfile: ScrapeUaProfile | null = null

export function derivePlatformFromOsToken(
  osToken: string
): Pick<
  ScrapeUaProfile,
  'platform' | 'secChUaPlatform' | 'platformVersion' | 'architecture' | 'bitness'
> {
  if (/Windows/i.test(osToken)) {
    const nt = osToken.match(/Windows NT ([\d.]+)/)?.[1] ?? '10.0'
    const platformVersion = nt === '10.0' ? '15.0.0' : `${nt}.0`
    return {
      platform: 'Windows',
      secChUaPlatform: '"Windows"',
      platformVersion,
      architecture: /arm64|aarch64/i.test(osToken) ? 'arm' : 'x86',
      bitness: /Win64|x64|WOW64/i.test(osToken) ? '64' : '32'
    }
  }
  if (/Mac OS X|Macintosh/i.test(osToken)) {
    const macVer = osToken.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.') ?? '10.15.7'
    return {
      platform: 'macOS',
      secChUaPlatform: '"macOS"',
      platformVersion: macVer,
      architecture: /arm64|aarch64/i.test(osToken) ? 'arm' : 'x86',
      bitness: '64'
    }
  }
  return {
    platform: 'Linux',
    secChUaPlatform: '"Linux"',
    platformVersion: '6.8.0',
    architecture: /aarch64|arm64/i.test(osToken) ? 'arm' : 'x86',
    bitness: '64'
  }
}

/** Build a Chrome-like UA from Chromium version + OS, without Electron/app tokens. */
export function buildScrapeUserAgent(rawFallback: string): string {
  const chromeMatch = rawFallback.match(/Chrome\/([\d.]+)/)
  const fullVersion = chromeMatch?.[1] ?? '130.0.0.0'
  const osToken = rawFallback.match(/Mozilla\/5\.0 \(([^)]+)\)/)?.[1] ?? 'Windows NT 10.0; Win64; x64'
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`
}

export function getScrapeUaProfile(): ScrapeUaProfile {
  if (cachedUaProfile) return cachedUaProfile

  const raw = app.userAgentFallback
  const chromeMatch = raw.match(/Chrome\/([\d.]+)/)
  const fullVersion = chromeMatch?.[1] ?? '130.0.0.0'
  const major = fullVersion.split('.')[0] || '130'
  const osToken = raw.match(/Mozilla\/5\.0 \(([^)]+)\)/)?.[1] ?? 'Windows NT 10.0; Win64; x64'

  cachedUaProfile = {
    userAgent: buildScrapeUserAgent(raw),
    major,
    fullVersion,
    ...derivePlatformFromOsToken(osToken)
  }
  return cachedUaProfile
}

export function cleanUserAgent(): string {
  return getScrapeUaProfile().userAgent
}

/** Test helper — reset cached profile between cases. */
export function resetScrapeUaProfileCache(): void {
  cachedUaProfile = null
}
