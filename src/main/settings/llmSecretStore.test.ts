import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  deleteLlmApiKey,
  getLlmApiKey,
  getLlmSecretStorageState,
  hasLlmApiKey,
  saveLlmApiKeys,
  setLlmSecretCipherForTests,
  type LlmSecretCipher
} from './llmSecretStore'

let tempRoot: string | null = null
let previousUserData: string | undefined

const degradedCipher: LlmSecretCipher = {
  state: () => ({ protection: 'degraded', backend: 'basic_text' }),
  encrypt: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
  decrypt: (value) => [...value.toString('utf8')].reverse().join('')
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-llm-secrets-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  setLlmSecretCipherForTests(degradedCipher)
})

afterEach(() => {
  setLlmSecretCipherForTests(null)
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('llmSecretStore', () => {
  it('persists encrypted values and reports a degraded Linux-style backend', () => {
    saveLlmApiKeys({ openai: 'sk-test-secret' })

    assert.equal(getLlmSecretStorageState().protection, 'degraded')
    assert.equal(hasLlmApiKey('openai'), true)
    assert.equal(getLlmApiKey('openai'), 'sk-test-secret')
    assert.equal(
      fs.readFileSync(path.join(tempRoot!, 'llm-secrets.json'), 'utf8').includes('sk-test-secret'),
      false
    )
  })

  it('removes a provider secret without affecting the remaining entries', () => {
    saveLlmApiKeys({ openai: 'one', deepseek: 'two' })
    deleteLlmApiKey('openai')

    assert.equal(getLlmApiKey('openai'), '')
    assert.equal(getLlmApiKey('deepseek'), 'two')
  })

  it('does not treat an unreadable secret path as an empty store', () => {
    fs.mkdirSync(path.join(tempRoot!, 'llm-secrets.json'))

    assert.throws(() => hasLlmApiKey('openai'), /读取 LLM 密钥失败/)
    assert.equal(fs.statSync(path.join(tempRoot!, 'llm-secrets.json')).isDirectory(), true)
  })
})
