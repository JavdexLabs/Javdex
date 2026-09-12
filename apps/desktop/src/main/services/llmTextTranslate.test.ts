import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTranslationOutput } from './llmTextTranslate'

describe('normalizeTranslationOutput', () => {
  it('strips fenced and quoted model output', () => {
    assert.equal(normalizeTranslationOutput('```\n你好世界\n```'), '你好世界')
    assert.equal(normalizeTranslationOutput('「示例标题」'), '示例标题')
    assert.equal(normalizeTranslationOutput('"示例标题"'), '示例标题')
  })
})
