/** App-injected helper copy; remove it before evaluating page content. */
const HELPER_TOOLBAR_COPY =
  /请在下方完成 Cloudflare 人机验证，完成后点击「验证通过」继续/g

/**
 * Tier 1 — structural markers from Cloudflare challenge bootstrapping scripts.
 * Any single hit is treated as high confidence (see CaptchaAI / scraping guides).
 */
const CF_STRONG_HTML_RE =
  /(?:_cf_chl_opt|(?:^|[^\w])cf_chl_[\w]+|challenge-platform|cdn-cgi\/challenge-platform|cf-browser-verification|(?:id|class)=["'][^"']*challenge-running|(?:^|[^\w])managed-challenge(?:[^\w]|$)|chl-answer|cf-challenge-running|cf-chl-widget)/i

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
  /<(?:main|article|section)[\s>]|<h1[\s>]|<div[^>]+class="[^"]*(?:movie|video|content|container|result|panel|detail)[^"]*"/i

/**
 * Normal site/application chrome. Used only to guard against stale transport
 * signals after the user has already passed an interstitial challenge.
 */
const NORMAL_CONTENT_RE =
  /<(?:main|article|section|nav)\b|class=["'][^"']*(?:navbar|movie-list|video-list|search-bar|search-panel|content|container|result|panel|detail)[^"']*["']/i

/** Detect Cloudflare verification pages so scrapers never parse them as content. */
export function isCloudflareChallengeText(
  input: string,
  options: { cfMitigated?: boolean; allowNormalContentOverride?: boolean } = {}
): boolean {
  if (!input?.trim()) return false
  const text = input.replace(HELPER_TOOLBAR_COPY, '')

  if (CF_STRONG_HTML_RE.test(text)) return true
  if (CF_INTERSTITIAL_TITLE_RE.test(text)) return true

  if (CF_INTERSTITIAL_BODY_RE.test(text) && CF_CO_SIGNAL_RE.test(text)) return true

  if (CF_TURNSTILE_RE.test(text) && !SUBSTANTIVE_CONTENT_RE.test(text)) return true

  if (options.cfMitigated) {
    return !(options.allowNormalContentOverride && NORMAL_CONTENT_RE.test(text))
  }

  return false
}
