/** Trusted IPC policy; renderers cannot increase worker budgets. Oversize data fails explicitly. */
export const SCAN_AUDIT_READ_LIMITS = Object.freeze({
  sourceBytes: 128 * 1024 * 1024,
  indexBytes: 256 * 1024 * 1024,
  pageBytes: 1024 * 1024
})
export const SCAN_AUDIT_HEADER_BYTES = 256 * 1024
