/** App-injected helper copy; remove it before evaluating page content. */
const HELPER_TOOLBAR_COPY =
  /请在下方完成 Cloudflare 人机验证，完成后点击「验证通过」继续/g

/** Injected toolbar host (shadow root content is not serialized into outerHTML). */
const HELPER_TOOLBAR_HOST = /<div id="__cf_helper_bar__"[^>]*>[\s\S]*?<\/div>/gi

/**
 * Active interstitial bootstrap — always treat as a challenge even if the shell
 * already has a little chrome.
 */
const CF_ACTIVE_CHALLENGE_RE =
  /(?:_cf_chl_opt|(?:^|[^\w])cf_chl_[\w]+|cf-browser-verification|(?:id|class)=["'][^"']*challenge-running|(?:^|[^\w])managed-challenge(?:[^\w]|$)|chl-answer|cf-challenge-running|cf-chl-widget)/i

/**
 * Passive Cloudflare infrastructure often present on normal pages after clearance.
 * Only counts when the document lacks real application chrome.
 */
const CF_PASSIVE_INFRA_RE = /(?:challenge-platform|cdn-cgi\/challenge-platform)/i

/** Tier 2 — canonical interstitial titles. */
const CF_INTERSTITIAL_TITLE_RE =
  /<title[^>]*>\s*(?:just a moment(?:\.{3})?|checking your browser[^<]*|attention required!\s*\|\s*cloudflare)[^<]*<\/title>/i

/**
 * Tier 3 — interstitial body phrases; require a Cloudflare co-signal to avoid
 * blog/docs false positives.
 */
const CF_INTERSTITIAL_BODY_RE =
  /(?:checking your browser(?:\s+before accessing[^.]*)?|enable javascript and cookies to continue|waiting for [\w.-]+ to respond|performance\s*&\s*security by cloudflare)/i

const CF_CO_SIGNAL_RE =
  /(?:cloudflare|challenge-platform|cf-browser-verification|ray id:|cf-ray|__cf_chl|cdn-cgi\/challenge)/i

/**
 * Tier 4 — embedded Turnstile on an otherwise empty shell (status-200 widget page).
 * Skip when the document already has normal content chrome.
 */
const CF_TURNSTILE_RE =
  /(?:cf-turnstile|challenges\.cloudflare\.com\/turnstile)/i

const SUBSTANTIVE_CONTENT_RE =
  /<(?:main|article|section)[\s>]|<h1[\s>]|<div[^>]+class="[^"]*(?:movie|video|content|container|result|panel|detail)[^"']*"/i

/**
 * Normal site/application chrome. Used to guard against stale transport
 * signals and passive Cloudflare scripts after the user has passed a challenge.
 */
const NORMAL_CONTENT_RE =
  /<(?:main|article|section|nav)\b|class=["'][^"']*(?:navbar|movie-list|video-list|video-detail|search-bar|search-panel|content|container|result|panel|detail|panel-block)[^"']*["']/i

export type CloudflareChallengeOptions = {
  cfMitigated?: boolean
  allowNormalContentOverride?: boolean
}

export type CloudflareChallengeDiagnosis = {
  challenge: boolean
  reasons: string[]
  hasNormalContent: boolean
}

function sanitizeChallengeInput(input: string): string {
  return input
    .replace(HELPER_TOOLBAR_COPY, '')
    .replace(HELPER_TOOLBAR_HOST, '')
}

export function hasNormalAppContent(input: string): boolean {
  const text = sanitizeChallengeInput(input)
  return SUBSTANTIVE_CONTENT_RE.test(text) || NORMAL_CONTENT_RE.test(text)
}

/** Explain why a page was (or was not) classified as a Cloudflare challenge. */
export function diagnoseCloudflareChallenge(
  input: string,
  options: CloudflareChallengeOptions = {}
): CloudflareChallengeDiagnosis {
  const reasons: string[] = []
  if (!input?.trim()) {
    return { challenge: false, reasons: ['empty sample'], hasNormalContent: false }
  }

  const text = sanitizeChallengeInput(input)
  const hasNormalContent = hasNormalAppContent(text)

  if (CF_ACTIVE_CHALLENGE_RE.test(text)) {
    reasons.push('active challenge bootstrap marker')
  }
  if (CF_INTERSTITIAL_TITLE_RE.test(text)) {
    reasons.push('interstitial <title>')
  }
  if (CF_PASSIVE_INFRA_RE.test(text)) {
    reasons.push(
      hasNormalContent
        ? 'passive challenge-platform script (ignored: normal content present)'
        : 'passive challenge-platform script on empty shell'
    )
  }
  if (CF_INTERSTITIAL_BODY_RE.test(text) && CF_CO_SIGNAL_RE.test(text)) {
    reasons.push('interstitial body copy with Cloudflare co-signal')
  }
  if (CF_TURNSTILE_RE.test(text) && !SUBSTANTIVE_CONTENT_RE.test(text)) {
    reasons.push('turnstile widget without substantive content')
  }
  if (options.cfMitigated) {
    reasons.push(
      hasNormalContent && options.allowNormalContentOverride
        ? 'cf-mitigated header (overridden by normal content)'
        : 'cf-mitigated: challenge response header'
    )
  }

  const challenge = isCloudflareChallengeText(input, options)
  if (!challenge && reasons.length === 0) {
    reasons.push('no challenge signals')
  }
  return { challenge, reasons, hasNormalContent }
}

/** Detect Cloudflare verification pages so scrapers never parse them as content. */
export function isCloudflareChallengeText(
  input: string,
  options: CloudflareChallengeOptions = {}
): boolean {
  if (!input?.trim()) return false
  const text = sanitizeChallengeInput(input)
  const hasNormalContent = hasNormalAppContent(text)

  if (CF_ACTIVE_CHALLENGE_RE.test(text)) return true
  if (CF_INTERSTITIAL_TITLE_RE.test(text)) return true

  if (CF_PASSIVE_INFRA_RE.test(text) && !hasNormalContent) return true

  if (CF_INTERSTITIAL_BODY_RE.test(text) && CF_CO_SIGNAL_RE.test(text)) return true

  if (CF_TURNSTILE_RE.test(text) && !SUBSTANTIVE_CONTENT_RE.test(text)) return true

  if (options.cfMitigated) {
    return !(options.allowNormalContentOverride && hasNormalContent)
  }

  return false
}
