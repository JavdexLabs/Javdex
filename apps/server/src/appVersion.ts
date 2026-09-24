import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readAppVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of [path.join(here, 'package.json'), path.join(here, '..', 'package.json')]) {
    try {
      const version = (JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string }).version
      if (typeof version === 'string' && version.trim()) return version
    } catch {
      // Source lives in src/; the production bundle sits next to package.json.
    }
  }
  throw new Error('无法读取应用版本')
}

export const SERVER_APP_VERSION = readAppVersion()
