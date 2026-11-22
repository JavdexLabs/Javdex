import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SubtitleOutputs } from '@shared/desktop/subtitleTasks'

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

export async function inspectSubtitleOutput(filename: string): Promise<{ name: string; revision: string | null } | null> {
  try {
    const stat = await fs.lstat(filename, { bigint: true })
    const revision = stat.isFile() ? createHash('sha256').update(JSON.stringify([
      filename, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
    ])).digest('hex') : null
    return { name: path.basename(filename), revision }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function inspectSubtitleOutputs(video: string): Promise<SubtitleOutputs> {
  const files: SubtitleOutputs = {}
  for (const output of ['bilingual', 'japanese'] as const) {
    const file = await inspectSubtitleOutput(subtitleOutputPath(video, output))
    if (file) files[output] = file
  }
  return files
}

/** Publish a complete file without clobbering an existing file, including a
 * concurrent writer. link is the cross-platform atomic no-replace operation.
 * Filesystems without hard links report a save error; Save As can use rename. */
export async function publishSubtitleFile(filename: string, content: string, replace: boolean | string = false): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.javdex-subtitle-${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    if (typeof replace === 'string' && (await inspectSubtitleOutput(filename))?.revision !== replace) {
      throw new Error('原字幕已变化，请另存或在保存对话框中确认替换')
    }
    if (replace) await fs.rename(temporary, filename)
    else await fs.link(temporary, filename)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}
