/** Runtime click classification, not a renderer guess from the user agent. */
export interface PointerTiming {
  doubleClickMs: number
  source: 'chromium' | 'system' | 'fallback'
}

// Keep ambiguous pointer singles conservative if the system query fails.
// Transport buttons and keyboard activation do not wait for this deadline.
export const fallbackPointerTiming: PointerTiming = { doubleClickMs: 5000, source: 'fallback' }
