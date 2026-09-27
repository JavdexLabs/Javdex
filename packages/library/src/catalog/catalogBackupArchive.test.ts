import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { packBackupArchive, unpackBackupArchive } from './catalogBackupArchive'
import { isStructuredError } from '@shared/protocol/errors'

describe('catalogBackupArchive', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('roundtrips files and rejects path escape, duplicates, and oversize archives', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-backup-archive-'))
    roots.push(root)
    const file = path.join(root, 'manifest.json')
    fs.writeFileSync(file, '{"ok":true}')
    const archive = path.join(root, 'pkg.tar.gz')
    await packBackupArchive([{ name: 'manifest.json', absPath: file }], archive)
    const dest = path.join(root, 'out')
    const unpacked = await unpackBackupArchive(archive, dest)
    assert.deepEqual(unpacked.files, ['manifest.json'])
    assert.equal(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'), '{"ok":true}')

    await assert.rejects(
      () => packBackupArchive([{ name: '../escape.txt', absPath: file }], path.join(root, 'bad.tar.gz')),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )
    await assert.rejects(
      () =>
        packBackupArchive(
          [
            { name: 'a.txt', absPath: file },
            { name: 'a.txt', absPath: file }
          ],
          path.join(root, 'dup.tar.gz')
        ),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )
    await assert.rejects(
      () =>
        packBackupArchive([{ name: 'manifest.json', absPath: file }], path.join(root, 'tiny.tar.gz'), {
          maxBytes: 16
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'LIMIT_EXCEEDED'
    )
  })

  it('rejects excessive decompressed tar padding', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-backup-padding-'))
    roots.push(root)
    const archive = path.join(root, 'padding.tar.gz')
    fs.writeFileSync(archive, gzipSync(Buffer.alloc(4096, 0)))
    await assert.rejects(
      unpackBackupArchive(archive, path.join(root, 'out'), { maxBytes: 32 }),
      (error: unknown) => isStructuredError(error) && error.code === 'LIMIT_EXCEEDED'
    )
  })
})
