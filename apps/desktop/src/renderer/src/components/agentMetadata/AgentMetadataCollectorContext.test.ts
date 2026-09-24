import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { declarationsFor } from '../../test/cssDeclarations'

const sourcePath = 'apps/desktop/src/renderer/src/components/agentMetadata/AgentMetadataCollectorContext.tsx'
const cssPath = 'apps/desktop/src/renderer/src/components/agentMetadata/AgentMetadataCollectorContext.module.css'

describe('Agent metadata collector intro', () => {
  it('explains how this flow differs from regular matching', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    assert.match(source, /和「修正匹配」不同/)
    assert.match(source, /粘贴详情页/)
    assert.match(source, /Agent 读取/)
    assert.match(source, /预览后写入/)
    assert.match(source, /<AgentMetadataSetupIntro/)
    assert.match(source, /className=\{styles\.stepCopy\}/)
  })

  it('keeps the setup steps compact and muted', () => {
    const intro = declarationsFor(cssPath, '.intro p')
    const step = declarationsFor(cssPath, '.steps li')
    const copy = declarationsFor(cssPath, '.stepCopy')

    assert.equal(intro.get('color'), 'var(--text-muted)')
    assert.equal(intro.get('font-size'), '12px')
    assert.equal(step.get('display'), 'flex')
    assert.equal(step.get('color'), 'var(--text-muted)')
    assert.equal(step.get('font-size'), '11px')
    assert.equal(copy.get('min-width'), '0')
  })
})
