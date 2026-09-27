import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DefaultPlayerDetectionResult } from '@shared/desktop/settings'

// Ask Windows for the current user's file association. Never execute its command string.
// File association does not prove support for HTTP playback; the user still saves the choice.
export const WINDOWS_PLAYER_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JavdexAssociation {
  [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)]
  private static extern uint AssocQueryString(uint flags, uint str, string assoc, string extra, StringBuilder output, ref uint length);
  public static string Executable(string extension) {
    uint length = 32768;
    var output = new StringBuilder((int)length);
    return AssocQueryString(0, 2, extension, "open", output, ref length) == 0 ? output.ToString() : null;
  }
}
'@
@('.mp4', '.mkv', '.avi') | ForEach-Object {
  $program = [JavdexAssociation]::Executable($_)
  if ($program) { [PSCustomObject]@{ path = $program; extension = $_ } }
} | ConvertTo-Json -Compress
`

const runFile = promisify(execFile)
async function queryWindows(): Promise<string> {
  const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await runFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PLAYER_QUERY, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8'
  })
  return stdout
}

export async function detectDefaultPlayer(dependencies: {
  platform?: NodeJS.Platform
  query?: () => Promise<string>
  isFile?: (value: string) => Promise<boolean>
} = {}): Promise<DefaultPlayerDetectionResult> {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    return { status: 'unavailable', message: '当前系统暂不支持检测默认播放器，请点击“选择程序”。' }
  }
  try {
    const raw = (await (dependencies.query ?? queryWindows)()).trim()
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    const isFile = dependencies.isFile ?? (async value => (await stat(value)).isFile())
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.path !== 'string' || !['.mp4', '.mkv', '.avi'].includes(candidate.extension)) continue
      const program = candidate.path.trim()
      if (!path.win32.isAbsolute(program) || path.win32.extname(program).toLowerCase() !== '.exe') continue
      if (/^(rundll32|explorer|applicationframehost|dllhost)\.exe$/i.test(path.win32.basename(program))) continue
      if (!await isFile(program).catch(() => false)) continue
      return { status: 'found', path: program, extension: candidate.extension }
    }
    return { status: 'unavailable', message: '未找到可直接调用的默认视频播放器，请点击“选择程序”。' }
  } catch {
    return { status: 'unavailable', message: '无法读取系统默认播放器，请点击“选择程序”。' }
  }
}
