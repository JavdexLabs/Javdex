import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  deleteScraperServiceToken,
  getScraperServiceSecretStorageState,
  getScraperServiceToken,
  hasScraperServiceToken,
  saveScraperServiceToken,
  setScraperServiceSecretCipherForTests,
  type ScraperServiceSecretCipher
} from './scraperServiceSecretStore'

let tempRoot: string | null = null
let previousUserData: string | undefined

const degradedCipher: ScraperServiceSecretCipher = {
  state: () => ({ protection: 'degraded', backend: 'basic_text' }),
  encrypt: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
  decrypt: (value) => [...value.toString('utf8')].reverse().join('')
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scraper-service-secrets-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  setScraperServiceSecretCipherForTests(degradedCipher)
})

afterEach(() => {
  setScraperServiceSecretCipherForTests(null)
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('scraperServiceSecretStore', () => {
  it('persists an encrypted MetaTube token without exposing plaintext', () => {
    saveScraperServiceToken('metatube', 'secret-token')

    assert.equal(getScraperServiceSecretStorageState().protection, 'degraded')
    assert.equal(hasScraperServiceToken('metatube'), true)
    assert.equal(getScraperServiceToken('metatube'), 'secret-token')
    assert.equal(
      fs.readFileSync(path.join(tempRoot!, 'scraper-service-secrets.json'), 'utf8')
        .includes('secret-token'),
      false
    )
  })

  it('clears the token and rejects unavailable encryption', () => {
    saveScraperServiceToken('metatube', 'secret-token')
    deleteScraperServiceToken('metatube')
    assert.equal(getScraperServiceToken('metatube'), '')

    setScraperServiceSecretCipherForTests({
      state: () => ({ protection: 'unavailable', backend: 'unavailable' }),
      encrypt: () => {
        throw new Error('unavailable')
      },
      decrypt: () => {
        throw new Error('unavailable')
      }
    })
    assert.throws(() => saveScraperServiceToken('metatube', 'next'), /凭证存储后端/)
  })
})
