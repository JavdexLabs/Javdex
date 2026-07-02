/**
 * Serializes all user-visible scrape runs that share the singleton scrapeBrowser.
 *
 * The browser session carries proxy, cookies and a visible verification window, so
 * overlapping video/actress/batch runs can otherwise close or retarget each other.
 */
class ScrapeRunCoordinator {
  private activeLabel: string | null = null

  isRunning(): boolean {
    return this.activeLabel !== null
  }

  getActiveLabel(): string | null {
    return this.activeLabel
  }

  async runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.activeLabel) {
      throw new Error(`${this.activeLabel}进行中，请稍后再试`)
    }

    this.activeLabel = label
    try {
      return await fn()
    } finally {
      this.activeLabel = null
    }
  }
}

export const scrapeRunCoordinator = new ScrapeRunCoordinator()
