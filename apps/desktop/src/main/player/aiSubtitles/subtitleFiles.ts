import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Only exact media stems and known qualifiers. Never match another disc/cut. */
export function matchesSubtitle(video: string, subtitle: string): boolean {
  if (!['.srt', '.ass'].includes(path.extname(subtitle).toLowerCase())) return false
  const stem = path.parse(video).name.normalize('NFC')
  const name = path.parse(subtitle).name.normalize('NFC')
  const normalize = (v: string): string => process.platform === 'win32' ? v.toLowerCase() : v
  if (normalize(stem) === normalize(name)) return true
  if (!normalize(name).startsWith(`${normalize(stem)}.`)) return false
  return name.slice(stem.length + 1).split('.').every(value => /^(zh(?:-cn|-tw|-hans|-hant|-ja)?|chs|cht|chi|zho|ja|jpn|en|eng|ko|kor|fr|fra|de|deu|es|spa|ru|rus|ai|forced|sdh|default)$/i.test(value))
}

export async function discoverSubtitleFiles(video: string): Promise<string[]> {
  const directory = path.dirname(video)
  const files: string[] = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    // Do not follow a sidecar symlink out of the authorized media directory.
    if (entry.isFile() && matchesSubtitle(path.basename(video), entry.name)) files.push(path.join(directory, entry.name))
  }
  return files.sort((a, b) => a.localeCompare(b))
}

export function subtitleOutputPath(video: string, output: 'bilingual' | 'japanese'): string {
  return path.join(path.dirname(video), `${path.parse(video).name}.${output === 'bilingual' ? 'zh-ja' : 'ja'}.ai.ass`)
}

/** Publish a complete file without clobbering an existing file, including a
 * concurrent writer. link is the cross-platform atomic no-replace operation.
 * Filesystems without hard links report a save error; Save As can use rename. */
export async function publishSubtitleFile(filename: string, content: string, replace = false): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.javdex-subtitle-${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    if (replace) await fs.rename(temporary, filename)
    else await fs.link(temporary, filename)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}
