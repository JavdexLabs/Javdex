import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginDevSession } from './types'
import { buildAgentSystemPrompt, buildInitialUserMessage } from './prompts'

function makeSession(): PluginDevSession {
  return {
    id: 'test-session',
    mode: 'create',
    kind: 'actress',
    status: 'running',
    siteName: 'Xslist',
    siteUrl: 'https://xslist.org/zh',
    supportedFields: [
      'avatar',
      'birthDate',
      'heightCm',
      'measurements',
      'profileSummary',
      'debutDate'
    ],
    package: {
      schemaVersion: 1,
      kind: 'actress',
      name: 'xslist',
      version: '1.0.0',
      homepage: 'https://xslist.org/zh',
      supportedFields: [
        'avatar',
        'birthDate',
        'heightCm',
        'measurements',
        'profileSummary',
        'debutDate'
      ],
      code: 'module.exports = { async parseActress(ctx) { return null } }'
    },
    pageNotes: [],
    duplicateDryRunCount: 0,
    step: 0,
    limits: {
      maxSteps: 1,
      maxContextTokens: 128000,
      maxDuplicateDryRun: 2,
      maxHtmlChars: 8000
    },
    finishRequested: false,
    cancelRequested: false,
    phase: 'discover',
    totalTokens: 0,
    incrementalEditOnly: false
  }
}

describe('pluginDevAgent prompts', () => {
  it('tells the agent that dynamic search may not change URL', () => {
    const prompt = buildAgentSystemPrompt('actress')

    assert.match(prompt, /优先使用标准 form/)
    assert.match(prompt, /AJAX 搜索/)
    assert.match(prompt, /URL 没变化/)
    assert.match(prompt, /ctx\.fetchPage/)
    assert.match(prompt, /反编 AJAX/)
    assert.match(prompt, /ctx\.browser\.html/)
    assert.match(prompt, /ctx\.cheerio\.load/)
    assert.match(prompt, /\$ is not a function/)
    assert.doesNotMatch(prompt, /不要依赖人工点击/)
  })

  it('keeps site prompts generic without hard-coded site endpoints', () => {
    const session = makeSession()
    const prompt = buildInitialUserMessage(
      {
        mode: 'create',
        kind: 'actress',
        siteName: 'Xslist',
        siteUrl: 'https://xslist.org/zh',
        supportedFields: [
          'avatar',
          'birthDate',
          'heightCm',
          'measurements',
          'profileSummary',
          'debutDate'
        ]
      },
      session
    )

    assert.doesNotMatch(prompt, /Xslist 特别提示/)
    assert.doesNotMatch(prompt, /search\?query=\{name\}&lg=\{lang\}/)
    assert.match(prompt, /主页或示例地址：https:\/\/xslist\.org\/zh/)
  })
})
