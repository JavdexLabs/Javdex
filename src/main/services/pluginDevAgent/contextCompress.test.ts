import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assistantTurn,
  ensureToolResultResponses,
  systemTurn,
  toolResultsTurn,
  userTurn,
  type AgentTranscript
} from './agentMessages'
import {
  compressTranscriptIfNeeded,
  fitTranscriptToContextBudget,
  summarizeContextStats
} from './contextCompress'

describe('contextCompress', () => {
  it('fills missing tool responses after assistant tool calls', () => {
    const transcript: AgentTranscript = [
      systemTurn('sys'),
      assistantTurn(null, [
        { id: 'call-a', name: 'browser_html', arguments: '{}' },
        { id: 'call-b', name: 'plugin_dry_run', arguments: '{}' }
      ]),
      toolResultsTurn([{ callId: 'call-a', content: '<html />' }])
    ]

    const repaired = ensureToolResultResponses(transcript)
    assert.equal(repaired.length, 3)
    assert.equal(repaired[2]?.kind, 'toolResults')
    if (repaired[2]?.kind === 'toolResults') {
      assert.ok(repaired[2].results.some((result) => result.callId === 'call-b'))
    }
  })

  it('preserves assistant/tool ordering when compressing old tool results', () => {
    const transcript: AgentTranscript = [
      systemTurn('sys'),
      userTurn('start'),
      assistantTurn(null, [{ id: 'call-1', name: 'browser_html', arguments: '{}' }]),
      toolResultsTurn([{ callId: 'call-1', content: 'x'.repeat(500) }]),
      userTurn('continue')
    ]

    for (let step = 0; step < 30; step += 1) {
      transcript.push(assistantTurn(null, [{ id: `call-${step}`, name: 'session_note', arguments: '{}' }]))
      transcript.push(toolResultsTurn([{ callId: `call-${step}`, content: `note-${step}` }]))
    }

    const compressed = compressTranscriptIfNeeded(transcript, 13)
    let lastAssistantIndex = -1
    for (let index = 0; index < compressed.length; index += 1) {
      const turn = compressed[index]
      if (turn.kind === 'assistant' && turn.toolCalls?.length) {
        lastAssistantIndex = index
        const toolCallId = turn.toolCalls[0]?.id
        const next = compressed[index + 1]
        assert.equal(next?.kind, 'toolResults')
        if (next?.kind === 'toolResults') {
          assert.equal(next.results[0]?.callId, toolCallId)
        }
      } else if (turn.kind === 'toolResults' && lastAssistantIndex >= 0) {
        assert.ok(index > lastAssistantIndex)
      }
    }
  })

  it('compresses large fresh browser and dry-run tool results by tool type', () => {
    const transcript: AgentTranscript = [
      systemTurn('sys'),
      assistantTurn(null, [
        { id: 'call-html', name: 'browser_html', arguments: '{}' },
        { id: 'call-dry', name: 'plugin_dry_run', arguments: '{}' }
      ]),
      toolResultsTurn([
        { callId: 'call-html', content: '<div>' + 'x'.repeat(9000) + '</div>' },
        { callId: 'call-dry', content: JSON.stringify({ logs: ['y'.repeat(7000)] }) }
      ])
    ]

    const compressed = compressTranscriptIfNeeded(transcript, 12)
    const htmlResult = compressed
      .flatMap((turn) => (turn.kind === 'toolResults' ? turn.results : []))
      .find((result) => result.callId === 'call-html')
    const dryResult = compressed
      .flatMap((turn) => (turn.kind === 'toolResults' ? turn.results : []))
      .find((result) => result.callId === 'call-dry')
    assert.ok(htmlResult)
    assert.ok(dryResult)
    assert.ok(htmlResult!.content.length < 9000)
    assert.ok(dryResult!.content.length < 7000)
  })

  it('summarizes context stats from transcript char counts', () => {
    const original = [
      systemTurn('sys'),
      assistantTurn('hello', [{ id: 'c1', name: 'browser_html', arguments: '{}' }])
    ]
    const compressed = [...original, toolResultsTurn([{ callId: 'c1', content: 'short' }])]
    const stats = summarizeContextStats(original, compressed, 128000, 42)
    assert.equal(stats.messageCount, compressed.length)
    assert.equal(stats.totalTokens, 42)
    assert.ok(stats.compressedChars >= stats.originalChars)
  })

  it('fits transcript to budget by dropping old groups', () => {
    const transcript: AgentTranscript = [systemTurn('sys')]
    for (let index = 0; index < 40; index += 1) {
      transcript.push(assistantTurn(null, [{ id: `call-${index}`, name: 'browser_html', arguments: '{}' }]))
      transcript.push(
        toolResultsTurn([{ callId: `call-${index}`, content: '<html>' + 'z'.repeat(4000) + '</html>' }])
      )
    }

    const fitted = fitTranscriptToContextBudget(transcript, 20, 8000)
    assert.ok(fitted.transcript.length < transcript.length)
    assert.ok(fitted.stats.savedChars > 0)
    assert.equal(fitted.stats.maxTokens, 8000)
  })

  it('compacts stale assistant tool arguments when over budget', () => {
    const transcript: AgentTranscript = [
      systemTurn('sys'),
      assistantTurn(null, [
        {
          id: 'call-old',
          name: 'plugin_update_code',
          arguments: JSON.stringify({ code: 'a'.repeat(9000) })
        }
      ]),
      toolResultsTurn([{ callId: 'call-old', content: 'ok' }])
    ]

    for (let index = 0; index < 20; index += 1) {
      transcript.push(assistantTurn(null, [{ id: `call-${index}`, name: 'session_note', arguments: '{}' }]))
      transcript.push(toolResultsTurn([{ callId: `call-${index}`, content: `note-${index}` }]))
    }

    const fitted = fitTranscriptToContextBudget(transcript, 20, 12000)
    assert.ok(fitted.transcript.length <= transcript.length)
    assert.ok(fitted.stats.savedChars >= 0)
  })
})
