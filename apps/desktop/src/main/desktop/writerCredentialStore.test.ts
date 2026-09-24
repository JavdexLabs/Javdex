import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { isStructuredError } from '@shared/protocol/errors'
import { createWriterCredentialStore, type WriterSecretCipher } from './writerCredentialStore'
import { thisComputerSettingsPath } from './thisComputerSettingsStore'

function memoryCipher(): WriterSecretCipher {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
  }
}

function unavailableCipher(): WriterSecretCipher {
  return {
    isAvailable: () => false,
    encrypt: () => {
      throw new Error('unavailable')
    },
    decrypt: () => {
      throw new Error('unavailable')
    }
  }
}

describe('writer credential store', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('stores encrypted secrets outside this-computer settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-writer-secret-'))
    roots.push(root)
    const store = createWriterCredentialStore({ userDataPath: root, cipher: memoryCipher() })
    await store.writeWriterSecret('catalog-a', 'secret-value')
    assert.equal(await store.readWriterSecret('catalog-a'), 'secret-value')
    const raw = fs.readFileSync(path.join(root, 'writer-secrets.json'), 'utf8')
    assert.doesNotMatch(raw, /secret-value/)
    assert.equal(fs.existsSync(thisComputerSettingsPath(root)), false)
  })

  it('refuses to write when secure storage is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-writer-secret-'))
    roots.push(root)
    const store = createWriterCredentialStore({ userDataPath: root, cipher: unavailableCipher() })
    assert.equal(await store.isAvailable(), false)
    await assert.rejects(
      () => store.writeWriterSecret('catalog-a', 'secret-value'),
      (error: unknown) => isStructuredError(error) && error.code === 'RECOVERY_REQUIRED'
    )
    assert.equal(fs.existsSync(path.join(root, 'writer-secrets.json')), false)
    assert.equal(fs.existsSync(thisComputerSettingsPath(root)), false)
  })
})
