import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { z } from 'zod'

export interface RuntimePackagePin { version: string; commit: string; runId: number; upstreamCommit: string }

/** Fixed flat ZIP protocol; do not execute any downloaded file while installing. */
export const runtimePackageExtractScript = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:JAVDEX_AI_ARCHIVE)
try {
  if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt 100) { throw 'runtime package entry limit' }
  $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $total = 0L
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName
    if ($name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' -or $name.EndsWith('.') -or
        $name -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])($|\\.)' -or !$names.Add($name) -or
        ($entry.ExternalAttributes -shr 16 -band 61440) -eq 40960) { throw 'unsafe runtime package entry' }
    $total += $entry.Length
    if ($total -gt [long]$env:JAVDEX_AI_EXPANDED_LIMIT) { throw 'runtime package size limit' }
    $target = [IO.Path]::Combine($env:JAVDEX_AI_DIRECTORY, $name)
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
  }
} finally { $archive.Dispose() }`

const safeName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  && !value.endsWith('.') && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])($|\.)/i.test(value)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z.object({
  formatVersion: z.literal(1), id: z.literal('whisper'), version: z.string(),
  target: z.object({ platform: z.literal('win32'), arch: z.literal('x64'), backend: z.literal('vulkan') }).strict(),
  interface: z.object({ id: z.literal('whisper-cli'), version: z.literal(1) }).strict(),
  entry: z.literal('whisper-cli.exe'), upstreamVersion: z.literal('b5130'), upstreamCommit: z.string(),
  provenance: z.object({ repository: z.literal('JavdexLabs/javdex-runtime'), commit: z.string(), runId: z.number().int().positive() }),
  checks: z.object({ cli: z.literal('passed'), kotoba: z.literal('passed'), vad: z.literal('passed'), gpu: z.enum(['passed', 'not-tested']) }),
  files: z.array(z.object({ name: z.string().refine(safeName), bytes: z.number().int().nonnegative(), sha256: digest }).strict()).min(5).max(99)
})
const required = ['whisper-cli.exe', 'vulkan-1.dll', 'LICENSE-whisper.txt', 'LICENSE-vulkan-loader.txt', 'SOURCE.json']
async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}
/** The outer ZIP is already size/hash pinned. Now verify its complete payload before promotion. */
export async function verifyRuntimePackage(directory: string, pin: RuntimePackagePin, limit: number,
  options: { installed?: boolean; fullHash?: boolean } = {}): Promise<void> {
  const fail = (): never => { throw new Error('运行库发行包完整性或目标校验失败') }
  const json = async (name: string): Promise<unknown> => {
    const filename = path.join(directory, name), stat = await fs.lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) fail()
    return JSON.parse(await fs.readFile(filename, 'utf8'))
  }
  const parsed = manifestSchema.safeParse(await json('runtime.json'))
  if (!parsed.success) fail()
  const manifest = parsed.data!
  if (manifest.version !== pin.version || manifest.upstreamCommit !== pin.upstreamCommit
    || manifest.provenance.commit !== pin.commit || manifest.provenance.runId !== pin.runId) fail()
  const names = new Set(['runtime.json']), lower = new Set(['runtime.json'])
  let total = (await fs.stat(path.join(directory, 'runtime.json'))).size
  for (const entry of manifest.files) {
    if (lower.has(entry.name.toLowerCase())) fail()
    names.add(entry.name); lower.add(entry.name.toLowerCase())
    const filename = path.join(directory, entry.name), stat = await fs.lstat(filename)
    total += stat.size
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || total > limit
      || (options.fullHash !== false && await hashFile(filename) !== entry.sha256)) fail()
  }
  if (required.some(name => !names.has(name))) fail()
  if (options.installed) names.add('asset.json')
  const actual = await fs.readdir(directory)
  if (actual.length !== names.size || actual.some(name => !names.has(name))) fail()
  const source = await json('SOURCE.json') as { commit?: unknown; upstream?: { commit?: unknown } }
  if (!source || source.commit !== pin.commit || source.upstream?.commit !== pin.upstreamCommit) fail()
}
