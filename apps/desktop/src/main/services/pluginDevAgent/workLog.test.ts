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
    session.package.supportedFields = ['title', 'cover']

    appendWorkLogUserMessage(session.id, '请修复标题', 'start')
    appendWorkLogEvent(session.id, {
      type: 'tool_start',
      sessionId: session.id,
      step: 1,
      tool: 'plugin_dry_run',
      args: { target: 'ABC-123' }
    })
    const longDetail = 'x'.repeat(800)
    appendWorkLogEvent(session.id, {
      type: 'tool_result',
      sessionId: session.id,
      step: 1,
      tool: 'plugin_dry_run',
      ok: true,
      summary: `ok ${'x'.repeat(235)}\ud83d`,
      detail: longDetail
    })
    appendWorkLogEvent(session.id, {
      type: 'assistant_reasoning',
      sessionId: session.id,
      step: 1,
      turn: 1,
      text: '页面事实已经足够，下一步应直接修改代码。',
      charCount: 22,
      truncated: false
    })

    const exported = buildPluginDevAgentWorkLog(session.id)
    assert.equal(exported.kind, 'pluginDevAgentWorkLog')
    assert.equal(exported.meta.siteName, 'LogSite')
    assert.deepEqual(exported.meta.supportedFields, ['title', 'cover'])
    assert.ok(exported.timeline.some((line) => line.includes('user(start)')))
    assert.ok(exported.timeline.some((line) => line.includes('tool_result plugin_dry_run ok')))
    assert.ok(exported.timeline.some((line) => line.includes('reasoning turn=1 chars=22')))
    const toolResult = exported.entries.find(
      (entry) => entry.kind === 'event' && entry.event.type === 'tool_result'
    )
    assert.ok(toolResult && toolResult.kind === 'event')
    assert.equal(
      toolResult.event.type === 'tool_result' ? toolResult.event.detail : '',
      longDetail
    )
    const reasoning = exported.entries.find(
      (entry) => entry.kind === 'event' && entry.event.type === 'assistant_reasoning'
    )
    assert.equal(
      reasoning?.kind === 'event' && reasoning.event.type === 'assistant_reasoning'
        ? reasoning.event.text
        : '',
      '页面事实已经足够，下一步应直接修改代码。'
    )

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-worklog-'))
    const outFile = path.join(outDir, 'log.json')
    try {
      writePluginDevAgentWorkLog(session.id, outFile)
      const raw = fs.readFileSync(outFile, 'utf-8')
      const parsed = JSON.parse(raw) as { schemaVersion: number }
      assert.equal(parsed.schemaVersion, 2)
      assert.equal(raw.includes('\\ud83d'), false)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('never exports a failed terminal state without an error event', () => {
    const session = createSession({
      mode: 'create',
      kind: 'video',
      siteName: 'FailedLogSite',
      siteUrl: 'https://example.com',
      supportedFields: [],
      testTargets: []
    })
    created.push(session.id)
    session.status = 'failed'

    const exported = buildPluginDevAgentWorkLog(session.id)
    const errors = exported.entries.filter(
      (entry) => entry.kind === 'event' && entry.event.type === 'error'
    )
    assert.equal(errors.length, 1)
    assert.match(exported.timeline.at(-1) ?? '', /error:/)
  })
})
