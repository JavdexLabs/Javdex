/** Keep renderer-visible export diagnostics actionable without exposing absolute local paths. */
export function sanitizeNfoExportMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/(['"])\\\\[^'"]+\1/gu, '$1[本地路径]$1')
    .replace(/(['"])(?:[A-Za-z]:[\\/]|\/)[^'"]+\1/gu, '$1[本地路径]$1')
    .replace(/\\\\(?:\?\\)?[^\s'"：]+(?:\\[^\s'"：]+)*/gu, '[本地路径]')
    .replace(/[A-Za-z]:[\\/](?:[^\s'"：]+[\\/])*[^\s'"：]*/gu, '[本地路径]')
    .replace(/(^|[\s(])\/[^\s'"：)]*/gu, '$1[本地路径]')
}
