import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetRunnerDepsForTest,
  __setRunnerDepsForTest,
  cancelPluginDevAgent,
  continuePluginDevAgent,
  startPluginDevAgent
} from './runner'
import { getSession, hashCode } from './sessionStore'
import type { AgentLlmResponse, AgentToolCall, AgentTurn } from './agentMessages'
import type { PluginDevAgentEvent, ToolExecutionResult } from './types'

let llmStep = 0

function makeToolCall(name: string, args: Record<string, unknown>): AgentToolCall {
  llmStep += 1
  return {
    id: `call-${llmStep}`,
    name,
    arguments: JSON.stringify(args)
  }
}

function makeAgentResponse(input: {
  text?: string | null
  toolCalls?: AgentToolCall[]
  usage?: AgentLlmResponse['usage']
}): AgentLlmResponse {
  return {
    text: input.text ?? null,
    toolCalls: input.toolCalls,
    usage: input.usage
  }
}

beforeEach(() => {
  llmStep = 0
  __resetRunnerDepsForTest()
})

afterEach(() => {
  __resetRunnerDepsForTest()
})

describe('pluginDevAgent runner', () => {
  it('accepts plugin_finish when dry-run and verification passed', async () => {
    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        llmStep += 1
        return makeAgentResponse({
          toolCalls: [makeToolCall('plugin_finish', { success: true, summary: 'done' })]
        })
      },
      executeToolFn: async (sessionId, toolName): Promise<ToolExecutionResult> => {
        const session = getSession(sessionId)
        if (!session) return { ok: false, content: 'missing session' }
        if (toolName === 'plugin_finish') {
          session.lastDryRun = {
            ok: true,
            result: { code: 'MUKD-573', title: 'sample', maker: 'Muku', publisher: 'Pub' },
            logs: []
          }
          session.lastVerification = {
            summary: 'ok',
            items: [
              { field: 'maker', status: 'ok', note: 'match' },
              { field: 'publisher', status: 'ok', note: 'match' }
            ]
          }
          return {
            ok: true,
            content: 'done',
            finish: { success: true, summary: 'done' }
          }
        }
        return { ok: true, content: 'ok' }
      }
    })

    const result = await startPluginDevAgent({
      mode: 'create',
      kind: 'video',
      siteName: 'tokyolib',
      supportedFields: ['title', 'maker', 'publisher'],
      testTargets: ['MUKD-573']
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.summary, 'done')
    assert.equal(result.dryRun?.ok, true)
  })

  it('rejects plugin_finish when verification has not passed', async () => {
    const toolCalls: string[] = []
    let finishAttempts = 0

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        llmStep += 1
        if (llmStep === 1) {
          return makeAgentResponse({
            toolCalls: [makeToolCall('plugin_finish', { success: true, summary: 'early' })]
          })
        }
        return makeAgentResponse({
          toolCalls: [makeToolCall('plugin_finish', { success: false, summary: 'failed verify' })]
        })
      },
      executeToolFn: async (sessionId, toolName): Promise<ToolExecutionResult> => {
        toolCalls.push(toolName)
        const session = getSession(sessionId)
        if (!session) return { ok: false, content: 'missing session' }

        if (toolName === 'plugin_finish') {
          finishAttempts += 1
          const success = finishAttempts === 1
          session.lastDryRun = {
            ok: true,
            result: { code: 'MUKD-573', maker: 'bad', publisher: 'MUKD' },
            logs: []
          }
          session.lastVerification = {
            summary: 'maker bad',
            items: [{ field: 'maker', status: 'suspicious', note: 'expected Muku', pageHint: 'Muku' }]
          }
          const summary = success ? 'early' : 'failed verify'
          return {
            ok: true,
            content: summary,
            finish: { success, summary }
          }
        }

        return { ok: true, content: 'ok' }
      }
    })

    const result = await startPluginDevAgent({
      mode: 'debug',
      kind: 'video',
      siteName: 'tokyolib',
      supportedFields: ['maker', 'publisher'],
      testTargets: ['MUKD-573'],
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'tokyolib',
        version: '1.0.0',
        supportedFields: ['maker', 'publisher'],
        code: "async function parseVideo(ctx) { return { code: ctx.code }; }\nmodule.exports = { parseVideo };"
      }
    })

    assert.equal(toolCalls[0], 'plugin_dry_run')
    assert.equal(toolCalls.filter((tool) => tool === 'plugin_finish').length, 2)
    assert.equal(result.status, 'failed')
  })

  it('starts debug sessions by dry-running the existing package before the model loop', async () => {
    const toolCalls: string[] = []
    const events: PluginDevAgentEvent[] = []
    let initialDryRunArgs: Record<string, unknown> | null = null

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        llmStep += 1
        return makeAgentResponse({
          toolCalls: [makeToolCall('plugin_finish', { success: false, summary: 'wait' })]
        })
      },
      executeToolFn: async (sessionId, toolName, rawArgs): Promise<ToolExecutionResult> => {
        toolCalls.push(toolName)
        const session = getSession(sessionId)
        if (!session) return { ok: false, content: 'missing session' }
        if (toolName === 'plugin_dry_run') {
          initialDryRunArgs = JSON.parse(rawArgs || '{}') as Record<string, unknown>
          session.lastDryRun = {
            ok: true,
            result: { code: 'PRED-877', title: 'old title' },
            logs: []
          }
          session.lastDryRunCodeHash = hashCode(session.package.code)
          return { ok: true, content: 'dry-run ok', structured: { summary: 'title=old title' } }
        }
        if (toolName === 'plugin_verify') {
          session.lastVerification = {
            summary: '验证通过',
            items: [{ field: 'title', status: 'ok', note: 'match' }]
          }
          return { ok: true, content: 'verify ok' }
        }
        return { ok: true, content: 'wait', finish: { success: false, summary: 'wait' } }
      }
    })

    await startPluginDevAgent(
      {
        mode: 'debug',
        kind: 'video',
        siteName: 'tokyolib',
        supportedFields: ['title'],
        testTargets: ['MUKD-573', 'PRED-877'],
        maxSteps: 1,
        package: {
          schemaVersion: 1,
          kind: 'video',
          name: 'tokyolib',
          version: '1.0.0',
          supportedFields: ['title'],
          code: "async function parseVideo(ctx) { return { code: ctx.code }; }\nmodule.exports = { parseVideo };"
        }
      },
      (event) => events.push(event)
    )

    assert.equal(toolCalls[0], 'plugin_dry_run')
    assert.equal(toolCalls[1], 'plugin_verify')
    assert.ok(initialDryRunArgs)
    const dryRunArgs = initialDryRunArgs as { testTargets?: string[] }
    assert.deepEqual(dryRunArgs.testTargets, ['MUKD-573', 'PRED-877'])
    const phases = events
      .filter((event): event is Extract<PluginDevAgentEvent, { type: 'phase_updated' }> =>
        event.type === 'phase_updated'
      )
      .map((event) => event.phase)
    const initialToolStarts = events
      .filter((event): event is Extract<PluginDevAgentEvent, { type: 'tool_start' }> =>
        event.type === 'tool_start' && event.step === 0
      )
      .map((event) => event.tool)
    assert.ok(phases.includes('verify'))
    assert.deepEqual(initialToolStarts.slice(0, 2), ['plugin_dry_run', 'plugin_verify'])
  })

  it('starts feedback sessions by dry-running the existing package before the model loop', async () => {
    const toolCalls: string[] = []

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> =>
        makeAgentResponse({
          toolCalls: [makeToolCall('plugin_finish', { success: false, summary: 'wait' })]
        }),
      executeToolFn: async (sessionId, toolName): Promise<ToolExecutionResult> => {
        toolCalls.push(toolName)
        const session = getSession(sessionId)
        if (!session) return { ok: false, content: 'missing session' }
        if (toolName === 'plugin_dry_run') {
          session.lastDryRun = {
            ok: true,
            result: { code: 'PRED-877', title: 'old title' },
            logs: []
          }
          session.lastDryRunCodeHash = hashCode(session.package.code)
          return { ok: true, content: 'dry-run ok', structured: { summary: 'title=old title' } }
        }
        if (toolName === 'plugin_verify') {
          session.lastVerification = {
            summary: '验证通过',
            items: [{ field: 'title', status: 'ok', note: 'match' }]
          }
          return { ok: true, content: 'verify ok' }
        }
        return { ok: true, content: 'wait', finish: { success: false, summary: 'wait' } }
      }
    })

    const result = await startPluginDevAgent({
      mode: 'feedback',
      kind: 'video',
      siteName: 'tokyolib',
      supportedFields: ['title'],
      testTargets: ['PRED-877'],
      userMessage: '标题不对',
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'tokyolib',
        version: '1.0.0',
        supportedFields: ['title'],
        code: "async function parseVideo(ctx) { return { code: ctx.code }; }\nmodule.exports = { parseVideo };"
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(toolCalls[0], 'plugin_dry_run')
    assert.equal(toolCalls[1], 'plugin_verify')
  })

  it('auto-runs verify after a successful dry-run tool call', async () => {
    const toolCalls: string[] = []
    const events: PluginDevAgentEvent[] = []

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> =>
        makeAgentResponse({
          toolCalls: [makeToolCall('plugin_dry_run', {})]
        }),
      executeToolFn: async (sessionId, toolName): Promise<ToolExecutionResult> => {
        toolCalls.push(toolName)
        const session = getSession(sessionId)
        if (!session) return { ok: false, content: 'missing session' }
        if (toolName === 'plugin_dry_run') {
          session.lastDryRun = {
            ok: true,
            result: { code: 'ABC-123', title: 'OK' },
            logs: []
          }
          session.lastDryRunCodeHash = hashCode(session.package.code)
          return { ok: true, content: 'dry-run ok', structured: { summary: 'title=OK' } }
        }
        if (toolName === 'plugin_verify') {
          session.lastVerification = {
            summary: '验证通过',
            items: [{ field: 'title', status: 'ok', note: 'match' }]
          }
          return {
            ok: true,
            content: 'verify ok',
            events: [
              {
                type: 'verification_updated',
                sessionId,
                step: 1,
                verification: session.lastVerification
              }
            ]
          }
        }
        return { ok: true, content: 'ok' }
      }
    })

    await startPluginDevAgent(
      {
        mode: 'create',
        kind: 'video',
        siteName: 'auto-verify',
        siteUrl: 'https://example.test',
        supportedFields: ['title'],
        testTargets: ['ABC-123'],
        maxSteps: 1,
        package: {
          schemaVersion: 1,
          kind: 'video',
          name: 'auto-verify',
          version: '1.0.0',
          supportedFields: ['title'],
          code: "async function parseVideo(ctx) { return { code: ctx.code, title: 'OK' }; }\nmodule.exports = { parseVideo };"
        }
      },
      (event) => events.push(event)
    )

    assert.deepEqual(toolCalls, ['plugin_dry_run', 'plugin_verify'])
    assert.equal(events.some((event) => event.type === 'verification_updated'), true)
  })

  it('keeps auto-verify failures as non-blocking dry-run feedback', async () => {
    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> =>
        makeAgentResponse({
          toolCalls: [makeToolCall('plugin_dry_run', {})]
        }),
      executeToolFn: async (sessionId, toolName): Promise<ToolExecutionResult> => {
        const session = getSession(sessionId)
        if (!session) return { ok: false, content: 'missing session' }
        if (toolName === 'plugin_dry_run') {
          session.lastDryRun = {
            ok: true,
            result: { code: 'ABC-123', title: 'OK', maker: 'wrong' },
            logs: []
          }
          session.lastDryRunCodeHash = hashCode(session.package.code)
          return { ok: true, content: 'dry-run ok' }
        }
        if (toolName === 'plugin_verify') {
          session.lastVerification = {
            summary: '仍有字段需修复',
            items: [
              { field: 'title', status: 'ok', note: 'match' },
              { field: 'maker', status: 'suspicious', note: 'expected Maker', pageHint: 'Maker' }
            ]
          }
          return { ok: false, content: 'maker mismatch' }
        }
        return { ok: true, content: 'ok' }
      }
    })

    const result = await startPluginDevAgent({
      mode: 'create',
      kind: 'video',
      siteName: 'auto-verify-soft',
      supportedFields: ['title', 'maker'],
      testTargets: ['ABC-123'],
      maxSteps: 1,
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'auto-verify-soft',
        version: '1.0.0',
        supportedFields: ['title', 'maker'],
        code: "async function parseVideo(ctx) { return { code: ctx.code, title: 'OK', maker: 'wrong' }; }\nmodule.exports = { parseVideo };"
      }
    })

    const session = getSession(result.sessionId)
    const toolResult = (session?.transcript ?? [])
      .filter((turn): turn is Extract<AgentTurn, { kind: 'toolResults' }> => turn.kind === 'toolResults')
      .flatMap((turn) => turn.results)
      .find((item) => item.content.includes('自动语义验证'))
    assert.ok(toolResult)
    assert.equal(toolResult.isError, false)
    assert.match(toolResult.content, /maker mismatch/)
  })

  it('fills skipped parallel tool responses when waiting for user', async () => {
    let chatCalls = 0

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        chatCalls += 1
        if (chatCalls === 1) {
          return makeAgentResponse({
            toolCalls: [
              makeToolCall('session_request_user', { reason: 'verify' }),
              { id: 'call-parallel', name: 'browser_status', arguments: '{}' }
            ]
          })
        }
        return makeAgentResponse({ text: 'done' })
      },
      executeToolFn: async (_sessionId, toolName): Promise<ToolExecutionResult> => {
        if (toolName === 'session_request_user') {
          return {
            ok: true,
            content: 'verify',
            waitForUser: 'verify'
          }
        }
        return { ok: true, content: 'should not run' }
      }
    })

    const result = await startPluginDevAgent({
      mode: 'create',
      kind: 'video',
      siteName: 'tokyolib',
      supportedFields: ['title'],
      testTargets: ['MUKD-573']
    })

    assert.equal(result.status, 'waiting_user')
    const session = getSession(result.sessionId)
    const toolIds = (session?.transcript ?? [])
      .filter((turn): turn is Extract<AgentTurn, { kind: 'toolResults' }> => turn.kind === 'toolResults')
      .flatMap((turn) => turn.results.map((item) => item.callId))
    assert.ok(toolIds.includes('call-parallel'))
  })

  it('reports step limit summary when max steps is reached', async () => {
    let chatCalls = 0

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        chatCalls += 1
        return makeAgentResponse({
          text: 'continue',
          toolCalls: [makeToolCall('browser_status', {})]
        })
      },
      executeToolFn: async (): Promise<ToolExecutionResult> => ({
        ok: true,
        content: '{"url":"https://example.com","title":"Example","isChallenge":false}'
      })
    })

    const result = await startPluginDevAgent({
      mode: 'create',
      kind: 'video',
      siteName: 'jav8',
      supportedFields: ['title'],
      testTargets: ['mida-670'],
      maxSteps: 2
    })

    assert.equal(result.status, 'failed')
    assert.match(result.summary, /2/)
    assert.equal(chatCalls, 2)
  })

  it('stops with cancelled summary when user cancels', async () => {
    let chatCalls = 0

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        chatCalls += 1
        return makeAgentResponse({
          text: 'probe',
          toolCalls: [makeToolCall('browser_status', {})]
        })
      },
      executeToolFn: async (sid, toolName): Promise<ToolExecutionResult> => {
        if (toolName === 'browser_status') {
          cancelPluginDevAgent(sid)
        }
        return {
          ok: true,
          content: '{"url":"https://example.com","title":"Example","isChallenge":false}'
        }
      }
    })

    const result = await startPluginDevAgent({
      mode: 'create',
      kind: 'video',
      siteName: 'jav8',
      supportedFields: ['title'],
      testTargets: ['mida-670'],
      maxSteps: 10
    })

    assert.equal(result.status, 'cancelled')
    assert.equal(result.summary, '\u7528\u6237\u5df2\u7ec8\u6b62')
    assert.equal(chatCalls, 1)
  })

  it('starts debug session with package code and user message', async () => {
    let initialUserMessage = ''

    __setRunnerDepsForTest({
      requestChat: async (transcript): Promise<AgentLlmResponse> => {
        const user = transcript.find((turn) => turn.kind === 'user')
        if (user?.kind === 'user' && !initialUserMessage) {
          initialUserMessage = user.text
        }
        return makeAgentResponse({ text: 'debug start' })
      },
      executeToolFn: async (): Promise<ToolExecutionResult> => ({
        ok: true,
        content: 'ok'
      })
    })

    const pluginCode =
      "async function parseVideo(ctx) { return { code: ctx.code, title: 'MissAV' }; }\nmodule.exports = { parseVideo };"

    const result = await startPluginDevAgent({
      mode: 'debug',
      kind: 'video',
      siteName: 'missav',
      supportedFields: ['title', 'actressesFemale'],
      testTargets: ['MUKD-484'],
      userMessage: 'alias hint',
      maxSteps: 1,
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'missav',
        version: '1.0.0',
        supportedFields: ['title', 'actressesFemale'],
        code: pluginCode
      }
    })

    assert.equal(result.status, 'failed')
    assert.ok(initialUserMessage.includes('debug'))
    assert.ok(initialUserMessage.includes('alias hint'))
    assert.ok(initialUserMessage.includes('code'))
    assert.equal(getSession(result.sessionId)?.package.code, pluginCode)
  })

  it('continues with prior transcript after cancel', async () => {
    let chatCalls = 0

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        chatCalls += 1
        if (chatCalls === 1) {
          return makeAgentResponse({
            text: 'probe',
            toolCalls: [makeToolCall('browser_status', {})]
          })
        }
        return makeAgentResponse({ text: 'continued' })
      },
      executeToolFn: async (sid, toolName): Promise<ToolExecutionResult> => {
        if (toolName === 'browser_status') {
          cancelPluginDevAgent(sid)
        }
        return {
          ok: true,
          content: '{"url":"https://example.com","title":"Example","isChallenge":false}'
        }
      }
    })

    const first = await startPluginDevAgent({
      mode: 'debug',
      kind: 'video',
      siteName: 'missav',
      supportedFields: ['title', 'actressesFemale'],
      testTargets: ['MUKD-484'],
      maxSteps: 1,
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'missav',
        version: '1.0.0',
        supportedFields: ['title', 'actressesFemale'],
        code: "async function parseVideo(ctx) { return { code: ctx.code }; }\nmodule.exports = { parseVideo };"
      }
    })

    assert.equal(first.status, 'cancelled')
    const before = getSession(first.sessionId)?.transcript?.length ?? 0
    assert.ok(before > 0)

    const second = await continuePluginDevAgent({
      sessionId: first.sessionId,
      text: 'follow-up feedback'
    })

    assert.equal(second.status, 'failed')
    assert.equal(chatCalls, 2)
    const session = getSession(first.sessionId)
    const userTurns = (session?.transcript ?? []).filter(
      (turn): turn is Extract<AgentTurn, { kind: 'user' }> => turn.kind === 'user'
    )
    assert.ok(userTurns.some((turn) => turn.text.includes('follow-up feedback')))
    assert.ok((session?.transcript?.length ?? 0) > before)
  })

  it('continue syncs manual dry-run hash with current code', async () => {
    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> =>
        makeAgentResponse({
          toolCalls: [makeToolCall('plugin_finish', { success: false, summary: 'stop' })]
        }),
      executeToolFn: async (): Promise<ToolExecutionResult> => ({
        ok: true,
        content: 'stop',
        finish: { success: false, summary: 'stop' }
      })
    })

    const code = `async function parseVideo(ctx) {
  return { code: ctx.code, title: 'Manual dry-run' };
}
module.exports = { parseVideo };`
    const first = await startPluginDevAgent({
      mode: 'create',
      kind: 'video',
      siteName: 'manual-dry-run',
      supportedFields: ['title'],
      testTargets: ['ABC-123'],
      maxSteps: 1,
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'provided-dry-run',
        version: '1.0.0',
        supportedFields: ['title'],
        code
      }
    })

    const providedDryRun = {
      ok: true,
      result: { code: 'ABC-123', title: 'Provided dry-run' },
      logs: []
    }
    await continuePluginDevAgent({
      sessionId: first.sessionId,
      text: '根据已有 dry-run 继续验证',
      lastDryRun: providedDryRun
    })

    const session = getSession(first.sessionId)
    assert.deepEqual(session?.lastDryRun, providedDryRun)
    assert.equal(session?.lastDryRunCodeHash, hashCode(code))
  })

  it('injects the same verification failure only once', async () => {
    let chatCalls = 0
    const code = `async function parseVideo(ctx) {
  return { code: ctx.code, maker: 'BAD' };
}
module.exports = { parseVideo };`

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        chatCalls += 1
        if (chatCalls === 1) {
          return makeAgentResponse({ toolCalls: [makeToolCall('plugin_verify', {})] })
        }
        if (chatCalls <= 3) {
          return makeAgentResponse({ toolCalls: [makeToolCall('browser_status', {})] })
        }
        return makeAgentResponse({
          toolCalls: [makeToolCall('plugin_finish', { success: false, summary: 'stop' })]
        })
      },
      executeToolFn: async (sessionId, toolName): Promise<ToolExecutionResult> => {
        const session = getSession(sessionId)
        if (!session) return { ok: false, content: 'missing session' }
        if (toolName === 'plugin_verify') {
          session.lastDryRun = {
            ok: true,
            result: { code: 'ABC-123', maker: 'BAD' },
            logs: []
          }
          session.lastDryRunCodeHash = hashCode(session.package.code)
          session.lastVerification = {
            summary: 'maker bad',
            items: [{ field: 'maker', status: 'suspicious', note: 'expected Maker' }]
          }
          return { ok: true, content: 'verified' }
        }
        if (toolName === 'plugin_finish') {
          return { ok: true, content: 'stop', finish: { success: false, summary: 'stop' } }
        }
        return { ok: true, content: 'status' }
      }
    })

    const result = await startPluginDevAgent({
      mode: 'debug',
      kind: 'video',
      siteName: 'dedupe',
      supportedFields: ['maker'],
      testTargets: ['ABC-123'],
      maxSteps: 5,
      package: {
        schemaVersion: 1,
        kind: 'video',
        name: 'dedupe',
        version: '1.0.0',
        supportedFields: ['maker'],
        code
      }
    })

    const userTurns = (getSession(result.sessionId)?.transcript ?? []).filter(
      (turn): turn is Extract<AgentTurn, { kind: 'user' }> => turn.kind === 'user'
    )
    assert.equal(userTurns.filter((turn) => turn.text.includes('验证未通过')).length, 1)
  })

  it('emits phase and context updates during the tool loop', async () => {
    let chatCalls = 0
    const events: PluginDevAgentEvent[] = []

    __setRunnerDepsForTest({
      requestChat: async (): Promise<AgentLlmResponse> => {
        chatCalls += 1
        if (chatCalls === 1) {
          return makeAgentResponse({
            toolCalls: [makeToolCall('browser_inspect', {})],
            usage: { promptTokens: 700, completionTokens: 300, totalTokens: 1000 }
          })
        }
        if (chatCalls === 2) {
          return makeAgentResponse({
            toolCalls: [
              makeToolCall('plugin_update_code', {
                mode: 'replace_all',
                code: "async function parseVideo(ctx) { return { code: ctx.code, title: 'OK' }; }\nmodule.exports = { parseVideo };"
              })
            ],
            usage: { promptTokens: 1400, completionTokens: 600, totalTokens: 2000 }
          })
        }
        return makeAgentResponse({
          toolCalls: [makeToolCall('plugin_finish', { success: false, summary: 'stop' })],
          usage: { promptTokens: 2100, completionTokens: 900, totalTokens: 3000 }
        })
      },
      executeToolFn: async (_sid, toolName): Promise<ToolExecutionResult> => {
        if (toolName === 'browser_inspect') return { ok: true, content: 'page insight' }
        if (toolName === 'plugin_update_code') return { ok: true, content: 'updated' }
        return { ok: true, content: 'stop', finish: { success: false, summary: 'stop' } }
      }
    })

    await startPluginDevAgent(
      {
        mode: 'create',
        kind: 'video',
        siteName: 'tokyolib',
        supportedFields: ['title'],
        testTargets: ['PRED-877'],
        maxSteps: 5,
        maxContextTokens: 16000
      },
      (event) => events.push(event)
    )

    const phases = events
      .filter((event): event is Extract<PluginDevAgentEvent, { type: 'phase_updated' }> =>
        event.type === 'phase_updated'
      )
      .map((event) => event.phase)
    assert.ok(phases.includes('discover'))
    assert.ok(phases.includes('implement'))
    assert.ok(phases.includes('finish'))

    const contextEvents = events.filter(
      (event): event is Extract<PluginDevAgentEvent, { type: 'context_updated' }> =>
        event.type === 'context_updated'
    )
    assert.ok(contextEvents.length >= 1)
    assert.ok(contextEvents[0].stats.estimatedTokens > 0)
    assert.equal(contextEvents[0].stats.maxTokens, 16000)
    assert.equal(contextEvents.at(-1)?.stats.totalTokens, 6000)
  })
})
