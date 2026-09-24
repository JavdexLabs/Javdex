export const MAINTENANCE_HINT_KEYS = {
  videoBanner: 'javdex:dismiss-unscraped-banner:video',
  actressBanner: 'javdex:dismiss-unscraped-banner:actress',
  scanScrapePrompt: 'javdex:dismiss-scan-scrape-prompt'
} as const

export function isMaintenanceHintDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function dismissMaintenanceHint(key: string): void {
  try {
    sessionStorage.setItem(key, '1')
  } catch {
    /* ignore quota / privacy mode */
  }
}
