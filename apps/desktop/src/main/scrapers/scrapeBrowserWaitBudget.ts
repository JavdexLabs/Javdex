export type ScrapeBrowserWaitStatus = 'active' | 'page-timeout' | 'verification-timeout'

export function canResolveScrapePage(
  isChallenge: boolean,
  hasStableContent: boolean
): boolean {
  return !isChallenge && hasStableContent
}

export function canResolveScrapeSelector(
  isChallenge: boolean,
  selectorFound: boolean
): boolean {
  return !isChallenge && selectorFound
}

/** Tracks page loading and manual verification timeout budgets for fetchPage(). */
export class ScrapeBrowserWaitBudget {
  private pageDeadlineAt: number
  private challengeStartedAt: number | null = null
  private challengeElapsedMs = 0

  constructor(
    startedAt: number,
    pageTimeoutMs: number,
    private readonly verificationTimeoutMs: number
  ) {
    this.pageDeadlineAt = startedAt + pageTimeoutMs
  }

  update(now: number, isChallenge: boolean): ScrapeBrowserWaitStatus {
    if (isChallenge) {
      this.challengeStartedAt ??= now
      if (
        this.challengeElapsedMs + now - this.challengeStartedAt >=
        this.verificationTimeoutMs
      ) {
        return 'verification-timeout'
      }
      return 'active'
    }

    if (this.challengeStartedAt !== null) {
      const elapsed = Math.max(0, now - this.challengeStartedAt)
      this.challengeElapsedMs += elapsed
      this.pageDeadlineAt += elapsed
      this.challengeStartedAt = null
    }

    return now >= this.pageDeadlineAt ? 'page-timeout' : 'active'
  }
}
