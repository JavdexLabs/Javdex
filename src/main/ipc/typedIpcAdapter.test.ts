import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'
import { executeIpcHandler } from './shared'
import { appIpcSchemas, videoIpcSchemas } from './ipcCommandSchemas'
import type { IpcMainInvokeEvent } from 'electron'

describe('typed IPC adapter', () => {
  it('forwards command arguments and returns the application result', async () => {
    let registered: ((id: number, rating: number) => unknown | Promise<unknown>) | null = null
    const adapter = createTypedIpcAdapter<VideoIpcContract>(
      videoIpcSchemas,
      (channel, handler) => {
        assert.equal(channel, IPC.VIDEO_SET_RATING)
        registered = (id: number, rating: number) =>
          handler({} as IpcMainInvokeEvent, id, rating)
      }
    )
    adapter.register(IPC.VIDEO_SET_RATING, (id, rating) => id === 7 && rating === 4)

    assert.equal(
      await (registered as ((id: number, rating: number) => unknown | Promise<unknown>) | null)?.(7, 4),
      true
    )
  })

  it('rejects malformed arguments before invoking the application handler', async () => {
    let registered: ((...args: unknown[]) => unknown | Promise<unknown>) | null = null
    let invoked = false
    const adapter = createTypedIpcAdapter<VideoIpcContract>(
      videoIpcSchemas,
      (_channel, handler) => {
        registered = (...args: unknown[]) => handler({} as IpcMainInvokeEvent, ...args)
      }
    )
    adapter.register(IPC.VIDEO_SET_RATING, () => {
      invoked = true
      return true
    })

    assert.throws(
      () => {
        void (registered as ((...args: unknown[]) => unknown | Promise<unknown>))(7, 9)
      },
      /无效的 IPC 请求参数/
    )
    assert.equal(invoked, false)
  })

  it('accepts link-resource updates without an import-only target', () => {
    const schema = videoIpcSchemas[IPC.VIDEO_RESOURCE_UPDATE]

    assert.equal(
      schema.safeParse([7, 11, { url: 'https://example.test/movie', kind: 'web' }]).success,
      true
    )
    assert.equal(
      schema.safeParse([
        7,
        11,
        {
          url: 'https://example.test/movie',
          kind: 'web',
          target: { kind: 'existing', videoId: 7 }
        }
      ]).success,
      false
    )
  })

  it('accepts one exact plugin approval decision and rejects malformed decisions', () => {
    const schema = appIpcSchemas[IPC.PLUGIN_DEV_AGENT_MESSAGE]
    assert.equal(
      schema.safeParse([{
        sessionId: 'run-1',
        text: '批准本次安装',
        approvalDecision: { requestId: 'apr-1', decision: 'approve' }
      }]).success,
      true
    )
    assert.equal(
      schema.safeParse([{
        sessionId: 'run-1',
        text: '批准',
        approvalDecision: { requestId: 'apr-1', decision: 'all' }
      }]).success,
      false
    )
  })

  it('accepts only explicit plugin continuation kinds', () => {
    const schema = appIpcSchemas[IPC.PLUGIN_DEV_AGENT_MESSAGE]
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '继续当前任务',
      continuationKind: 'resume'
    }]).success, true)
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '标题仍然不正确',
      continuationKind: 'user_feedback'
    }]).success, true)
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '继续当前任务',
      continuationKind: 'continue'
    }]).success, false)
  })

  it('accepts only typed plugin user responses with request-bound actions', () => {
    const schema = appIpcSchemas[IPC.PLUGIN_DEV_AGENT_MESSAGE]
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '',
      userResponse: {
        requestId: 'choice-1',
        type: 'choice',
        optionId: '1'
      }
    }]).success, true)
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '',
      userResponse: {
        requestId: 'login-1',
        type: 'browser_interaction',
        action: 'completed'
      }
    }]).success, true)
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '',
      userResponse: {
        requestId: 'unsupported-1',
        type: 'unsupported_browser_request',
        action: 'completed'
      }
    }]).success, false)
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '',
      userResponse: {
        requestId: 'freeform-1',
        type: 'freeform',
        text: '页面需要登录'
      }
    }]).success, true)
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '1',
      userResponse: { requestId: 'choice-1', type: 'choice' }
    }]).success, false)
    assert.equal(schema.safeParse([{
      sessionId: 'run-1',
      text: '',
      approvalDecision: { requestId: 'approval-1', decision: 'approve' },
      userResponse: { requestId: 'choice-1', type: 'choice', optionId: '1' }
    }]).success, true, 'cross-protocol rejection belongs to PluginDeveloper, not IPC shape validation')
  })

  it('accepts plugin history clearing only without renderer-supplied run ids', () => {
    const schema = appIpcSchemas[IPC.PLUGIN_DEV_AGENT_CLEAR_HISTORY]
    assert.equal(schema.safeParse([]).success, true)
    assert.equal(schema.safeParse(['run-1']).success, false)
  })

  it('accepts unrecoverable plugin-session discard only without renderer-supplied run ids', () => {
    const schema = appIpcSchemas[IPC.PLUGIN_DEV_AGENT_DISCARD_UNRECOVERABLE]
    assert.equal(schema.safeParse([]).success, true)
    assert.equal(schema.safeParse(['run-1']).success, false)
  })

  it('keeps legacy model limits out of the generic settings mutation contract', () => {
    const schema = appIpcSchemas[IPC.SETTINGS_UPDATE]
    assert.equal(schema.safeParse([{ pluginDevAgentMaxTurns: 0 }]).success, false)
    assert.equal(schema.safeParse([{ pluginDevAgentMaxSteps: 24 }]).success, false)
  })

  it('accepts only the structured model-management command vocabulary', () => {
    const schema = appIpcSchemas[IPC.SETTINGS_MODEL_MANAGEMENT_APPLY]
    assert.equal(schema.safeParse([{
      expectedRevision: 'revision-1',
      command: {
        type: 'set-workload-assignment',
        workloadId: 'plugin-developer',
        model: { mode: 'inherit-default' },
        runtime: {
          thinkingLevel: 'medium',
          maxTokens: 0,
          timeoutMs: 120_000,
          cacheRetention: 'short'
        },
        compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        limits: { maxTurns: 0, maxContextTokens: 128_000 }
      }
    }]).success, true)
    assert.equal(schema.safeParse([{
      expectedRevision: 'revision-1',
      command: {
        type: 'set-workload-assignment',
        workloadId: 'app-default',
        model: { mode: 'inherit-default' }
      }
    }]).success, false)
    assert.equal(schema.safeParse([{
      expectedRevision: 'revision-1',
      command: { type: 'rewrite-route', routeId: 'route:primary' }
    }]).success, false)
  })

  it('serializes successful results and thrown errors', async () => {
    assert.deepEqual(await executeIpcHandler((value: number) => value * 2, [3]), {
      ok: true,
      data: 6
    })
    assert.deepEqual(
      await executeIpcHandler(() => {
        throw new Error('broken')
      }, []),
      { ok: false, error: 'broken' }
    )
  })

  it('sends the contracted event payload unchanged', () => {
    interface TestEvents {
      [IPC.SCRAPE_BATCH_PROGRESS]: { current: number }
    }
    const sent: unknown[][] = []
    createTypedEventAdapter<TestEvents>().send(
      { send: (...args: unknown[]) => sent.push(args) },
      IPC.SCRAPE_BATCH_PROGRESS,
      { current: 3 }
    )

    assert.deepEqual(sent, [[IPC.SCRAPE_BATCH_PROGRESS, { current: 3 }]])
  })
})
