export type ScrapeBrowserWaitStatus = 'active' | 'waiting-for-verification' | 'page-timeout' | 'verification-timeout'

interface ChallengeObservation {
  detected: boolean
  relaxed?: boolean
  expectedContent?: boolean
  confirmed?: boolean
}

/** Tracks the normal page budget and cumulative time spent waiting for manual verification. */
export class ScrapeBrowserWaitBudget {
  private pageDeadlineAt: number
  private challengeStartedAt: number | null = null
  private challengeElapsedMs = 0
  private deferredVerification = false

  constructor(
    startedAt: number,
    private readonly pageTimeoutMs: number,
    private readonly verificationTimeoutMs: number
  ) {
    this.pageDeadlineAt = startedAt + pageTimeoutMs
  }

  update(now: number, { detected, relaxed = false, expectedContent = false, confirmed = false }: ChallengeObservation): ScrapeBrowserWaitStatus {
    const blocked = detected && !(relaxed && expectedContent)
    if (this.challengeStartedAt !== null && (confirmed || !blocked)) {
      const elapsed = Math.max(0, now - this.challengeStartedAt)
      this.challengeElapsedMs += elapsed
      // A deferred challenge used up the page budget before it was shown.
      // Give the current page time to reload or settle after verification.
      this.pageDeadlineAt = this.deferredVerification ? now + this.pageTimeoutMs : this.pageDeadlineAt + elapsed
      this.challengeStartedAt = null
      this.deferredVerification = false
    }
    if (blocked && (!relaxed || this.challengeStartedAt !== null || now >= this.pageDeadlineAt)) {
      if (this.challengeStartedAt === null) {
        this.challengeStartedAt = now
        this.deferredVerification = now >= this.pageDeadlineAt
      }
      return this.challengeElapsedMs + now - this.challengeStartedAt >= this.verificationTimeoutMs
        ? 'verification-timeout' : 'waiting-for-verification'
    }
    return now >= this.pageDeadlineAt ? 'page-timeout' : 'active'
  }
}
