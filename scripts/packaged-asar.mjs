import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { listPackage, statFile } from '@electron/asar'

/** Packaging only: source/native build contexts do not install ASAR tools. */
export function verifyAsarUnpackedFiles(archive) {
  for (const entry of listPackage(archive)) {
    // ASAR lists paths with the host separator, including a leading root.
    const name = entry.replace(/^[/\\]+/, ''), stat = statFile(archive, name, false)
    if (stat.unpacked && !stat.files && !stat.link) {
      assert.ok(existsSync(path.join(archive + '.unpacked', name)), `Missing ASAR unpacked file: ${name}`)
    }
  }
}
