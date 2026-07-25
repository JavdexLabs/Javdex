import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSession, deleteSession } from './sessionStore'
import {
  appendWorkLogEvent,
  appendWorkLogUserMessage,
  buildPluginDevAgentWorkLog,
  writePluginDevAgentWorkLog
} from './workLog'

const created: string[] = []

afterEach(() => {
  for (const id of created.splice(0)) deleteSession(id)
})

describe('pluginDevAgent workLog', () => {
  it('records full tool detail and builds an exportable timeline', () => {
    const session = createSession({
      mode: 'debug',
      kind: 'video',
      siteName: 'LogSite',
      siteUrl: 'https://example.com',
      supportedFields: ['title'],
      testTargets: ['ABC-123'],
      userMessage: '请修复标题'
    })
    created.push(session.id)

    appendWorkLogUserMessage(session.id, '请修复标题', 'start')
    appendWorkLogEvent(session.id, {
      type: 'tool_start',
      sessionId: session.id,
      step: 1,
      tool: 'plugin_dry_run',
      args: { testTarget: 'ABC-123' }
    })
    const longDetail = 'x'.repeat(800)
    appendWorkLogEvent(session.id, {
      type: 'tool_result',
      sessionId: session.id,
      step: 1,
      tool: 'plugin_dry_run',
      ok: true,
      summary: 'ok',
      detail: longDetail
    })

    const exported = buildPluginDevAgentWorkLog(session.id)
    assert.equal(exported.kind, 'pluginDevAgentWorkLog')
    assert.equal(exported.meta.siteName, 'LogSite')
    assert.ok(exported.timeline.some((line) => line.includes('user(start)')))
    assert.ok(exported.timeline.some((line) => line.includes('tool_result plugin_dry_run ok')))
    const toolResult = exported.entries.find(
      (entry) => entry.kind === 'event' && entry.event.type === 'tool_result'
    )
    assert.ok(toolResult && toolResult.kind === 'event')
    assert.equal(
      toolResult.event.type === 'tool_result' ? toolResult.event.detail : '',
      longDetail
    )

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-worklog-'))
    const outFile = path.join(outDir, 'log.json')
    try {
      writePluginDevAgentWorkLog(session.id, outFile)
      const parsed = JSON.parse(fs.readFileSync(outFile, 'utf-8')) as { schemaVersion: number }
      assert.equal(parsed.schemaVersion, 1)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })
})
