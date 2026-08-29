import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const RECENT_INPUT_FILES = [
  'src/renderer/src/components/MediaLibraryCreateModal.tsx',
  'src/renderer/src/components/agentMetadata/AgentMetadataCollectorContext.tsx',
  'src/renderer/src/pages/HomePage.tsx',
  'src/renderer/src/pages/MediaLibrarySettingsDialogs.tsx',
  'src/renderer/src/pages/MediaLibrarySettingsTabs.tsx'
] as const

function textLikeInputs(source: string): string[] {
  return [...source.matchAll(/<input\b[\s\S]*?\/>/g)]
    .map((match) => match[0])
    .filter((input) => !/type=["'](?:checkbox|radio)["']/.test(input))
}

describe('recent text input style contract', () => {
  it('uses the shared text-input treatment for every recent text-like input', () => {
    let auditedInputCount = 0

    for (const file of RECENT_INPUT_FILES) {
      const source = readFileSync(path.resolve(file), 'utf8')
      const inputs = textLikeInputs(source)
      auditedInputCount += inputs.length
      for (const input of inputs) {
        assert.match(input, /className=(?:["'][^"']*\btext-input\b|\{`[^`]*\btext-input\b)/, file)
      }
    }

    assert.equal(auditedInputCount, 10)
  })
})
