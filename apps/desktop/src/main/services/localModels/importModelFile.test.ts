import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { importModelFile } from './importModelFile'

test('import verifies copied bytes, preserves originals and existing models on rejection, and cleans staging files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-import-'))
  const source = path.join(root, 'download.gguf'), destination = path.join(root, 'installed', 'model.gguf')
  const data = Buffer.from('valid model'), expected = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  try {
    await fs.writeFile(source, data)
    await importModelFile(source, destination, expected)
    assert.deepEqual(await fs.readFile(source), data)
    assert.deepEqual(await fs.readFile(destination), data)
    await fs.writeFile(source, 'short')
    await assert.rejects(importModelFile(source, destination, expected), /大小/)
    await fs.writeFile(source, Buffer.alloc(data.length))
    await assert.rejects(importModelFile(source, destination, expected), /SHA-256/)
    assert.deepEqual(await fs.readFile(destination), data)
    assert.deepEqual(await fs.readdir(path.dirname(destination)), ['model.gguf'])
    await importModelFile(destination, destination, expected)
    assert.deepEqual(await fs.readFile(destination), data)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
