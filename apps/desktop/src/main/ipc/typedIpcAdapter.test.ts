import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'
import { structuredError } from '@shared/protocol/errors'
import { executeIpcHandler } from './shared'
import { actressIpcSchemas, appIpcSchemas, videoIpcSchemas } from './ipcCommandSchemas'
import type { IpcMainInvokeEvent } from 'electron'

it('validates manual tag candidate bounds and existing-tag identities', () => {
  for (const channel of [IPC.TAG_MANUAL_OPTIONS, IPC.TAG_FILTER_OPTIONS] as const) {
    const options = appIpcSchemas[channel]
    assert.equal(options.safeParse([{}]).success, true)
    assert.equal(options.safeParse([{ search: 'École', limit: 100, offset: 100 }]).success, true)
    for (const query of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { search: 'x'.repeat(501) }, { extra: true }]) {
      assert.equal(options.safeParse([query]).success, false)
    }
  }
  const attach = videoIpcSchemas[IPC.VIDEO_MANUAL_TAG_ADD_EXISTING]
  assert.equal(attach.safeParse([1, 2]).success, true)
  for (const args of [[0, 2], [1, -1], [1, 1.5], [1, Number.MAX_SAFE_INTEGER + 1], [1, 'name']]) {
    assert.equal(attach.safeParse(args).success, false)
  }
})

it('bounds selected tag label IPC requests before repository access', () => {
  const schema = appIpcSchemas[IPC.TAG_LABELS]
  assert.equal(schema.safeParse([[]]).success, true)
  assert.equal(schema.safeParse([Array.from({ length: 100 }, (_, index) => index + 1)]).success, true)
  for (const args of [[[0]], [[-1]], [[1.5]], [[Number.MAX_SAFE_INTEGER + 1]], [Array(101).fill(1)], [[1], 'extra']]) {
    assert.equal(schema.safeParse(args).success, false)
  }
})
describe('typed IPC adapter', () => {
  it('does not expose the legacy unreviewed video deletion command', () => {
    assert.equal('VIDEO_DELETE' in IPC, false)
    assert.equal(Object.values(IPC).includes('video:delete' as never), false)
    assert.equal('video:delete' in videoIpcSchemas, false)
  })

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
      schema.safeParse([3, 7, 11, { url: 'https://example.test/movie', kind: 'web' }]).success,
      true
    )
    assert.equal(
      schema.safeParse([
        3,
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

  it('only accepts metadata retention when removing a last video resource', () => {
    const schema = videoIpcSchemas[IPC.VIDEO_RESOURCE_REMOVE]

    assert.equal(schema.safeParse([1, 7, 11, 'retain-video']).success, true)
    assert.equal(schema.safeParse([1, 7, 11, 'delete-video']).success, false)
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

  it('validates playlist import start and identity controls at the IPC boundary', () => {
    const legacyStart = appIpcSchemas[IPC.PLAYLIST_IMPORT_START].safeParse([{
      idempotencyKey: 'start-1',
      sourceUrl: 'https://example.test/list',
      targetLibraryId: 2,
      destination: { kind: 'append', playlistId: 9 }
    }])
    assert.equal(legacyStart.success, true)
    assert.equal(legacyStart.success && legacyStart.data[0].autoCreateUnmatchedVideos, true)
    assert.equal(legacyStart.success && legacyStart.data[0].saveDetailLinks, true)
    assert.equal(legacyStart.success && legacyStart.data[0].saveSourcePlaylistLink, false)
    assert.equal(appIpcSchemas[IPC.PLAYLIST_IMPORT_START].safeParse([{
      idempotencyKey: 'start-2',
      sourceUrl: 'https://example.test/list',
      targetLibraryId: 2,
      destination: { kind: 'append', playlistId: 9 },
      autoCreateUnmatchedVideos: false,
      saveDetailLinks: false,
      saveSourcePlaylistLink: true
    }]).success, true)
    assert.equal(appIpcSchemas[IPC.PLAYLIST_IMPORT_START].safeParse([{
      idempotencyKey: 'start-1',
      sourceUrl: 'https://example.test/list',
      targetLibraryId: 2,
      destination: { kind: 'append' }
    }]).success, false)
    assert.equal(appIpcSchemas[IPC.PLAYLIST_IMPORT_CONTROL].safeParse([
      'run-1',
      {
        kind: 'resolve-identities',
        expectedRevision: 4,
        idempotencyKey: 'resolve-1',
        decisions: [{ itemId: 8, choice: { kind: 'existing', videoId: 21 } }]
      }
    ]).success, true)
  })

  it('requires the path-removal impact revision at the settings boundary', () => {
    const schema = appIpcSchemas[IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM]
    assert.equal(schema.safeParse([3, 8, 2, 'a'.repeat(64)]).success, true)
    assert.equal(schema.safeParse([3, 8, 2]).success, false)
    assert.equal(schema.safeParse([3, 8, 2, 'stale']).success, false)
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
      {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'broken',
          details: undefined,
          operationId: undefined,
          recovery: 'correctInput'
        }
      }
    )
    assert.deepEqual(
      await executeIpcHandler(() => {
        throw structuredError('CONNECTION_UNAVAILABLE', '远程资料库尚未配置')
      }, []),
      {
        ok: false,
        error: {
          code: 'CONNECTION_UNAVAILABLE',
          message: '远程资料库尚未配置',
          details: undefined,
          operationId: undefined,
          recovery: 'retryConnection'
        }
      }
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

it('bounds actress conflict summary pages and keeps detail identities exact',()=>{
  const schema=actressIpcSchemas[IPC.ACTRESS_CONFLICT_QUEUE_PAGE]
  assert.equal(schema.safeParse([{limit:100,offset:100,anchorName:'演员名'}]).success,true)
  for(const query of [{limit:101},{limit:0},{offset:-1},{offset:Number.MAX_SAFE_INTEGER+1},{anchorName:''},{extra:true}])assert.equal(schema.safeParse([query]).success,false)
  assert.equal(actressIpcSchemas[IPC.ACTRESS_CONFLICT_GET].safeParse(['Exact Name']).success,true)
  assert.equal(actressIpcSchemas[IPC.ACTRESS_CONFLICT_GET].safeParse(['']).success,false)
})


it('validates bounded actress picker requests', () => {
  const schema = actressIpcSchemas[IPC.ACTRESS_PICKER_PAGE]
  assert.equal(schema.safeParse([undefined]).success, true)
  assert.equal(schema.safeParse([{ limit: 100, offset: 40, search: 'name' }]).success, true)
  for (const query of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 },
    { offset: Infinity }, { search: 'x'.repeat(257) }, { extra: true }]) {
    assert.equal(schema.safeParse([query]).success, false)
  }
})


it('validates narrow actress identity IDs', () => {
  const schema = actressIpcSchemas[IPC.ACTRESS_PICKER_GET]
  assert.equal(schema.safeParse([1]).success, true)
  for (const args of [[0], [-1], [1.5], [Infinity], [Number.MAX_SAFE_INTEGER+1], ['1'], [1, 2]]) {
    assert.equal(schema.safeParse(args).success, false)
  }
})


it('validates merge candidate paging and keep identity', () => {
  const schema = actressIpcSchemas[IPC.ACTRESS_MERGE_CANDIDATES]
  assert.equal(schema.safeParse([{keepId:1,limit:100,offset:40,search:'name'}]).success,true)
  for (const query of [{},{keepId:0},{keepId:1.5},{keepId:1,limit:101},{keepId:1,offset:-1},{keepId:1,search:'x'.repeat(257)},{keepId:1,gender:'female'}]) {
    assert.equal(schema.safeParse([query]).success,false)
  }
})


it('accepts only zero arguments for avatar crop count', () => {
  const schema = actressIpcSchemas[IPC.ACTRESS_AVATAR_CROP_COUNT]
  assert.equal(schema.safeParse([]).success, true)
  assert.equal(schema.safeParse([1]).success, false)
})


it('accepts only zero arguments for avatar crop target enumeration', () => {
  const schema = actressIpcSchemas[IPC.ACTRESS_AVATAR_CROP_TARGETS]
  assert.equal(schema.safeParse([]).success, true)
  assert.equal(schema.safeParse([1]).success, false)
})


it('validates plugin actress test picker bounds and identities', () => {
  const page=actressIpcSchemas[IPC.ACTRESS_TEST_TARGET_PAGE]
  assert.equal(page.safeParse([{}]).success,true)
  for(const q of [{limit:101},{offset:-1},{search:'x'.repeat(257)},{gender:'male'}])assert.equal(page.safeParse([q]).success,false)
  const get=actressIpcSchemas[IPC.ACTRESS_TEST_TARGET_GET]
  assert.equal(get.safeParse([1]).success,true)
  for(const id of [0,-1,1.5,Infinity])assert.equal(get.safeParse([id]).success,false)
})

it('validates actress works page bounds and rejects unexpected filter fields', () => {
  const schema = actressIpcSchemas[IPC.ACTRESS_VIDEO_PAGE]
  assert.equal(schema.safeParse([1]).success, true)
  assert.equal(schema.safeParse([1, { limit: 240, offset: 0 }]).success, true)
  for (const args of [[0], [1, { limit: 241 }], [1, { limit: 0 }], [1, { offset: -1 }], [1, { offset: Infinity }], [1, { offset: Number.MAX_SAFE_INTEGER + 1 }], [1, { gender: 'male' }]]) {
    assert.equal(schema.safeParse(args).success, false)
  }
})

it('validates metadata IDs and the optional cover-only actor works filter', () => {
  const metadata = actressIpcSchemas[IPC.ACTRESS_METADATA]
  assert.equal(metadata.safeParse([1]).success, true)
  for (const id of [0, -1, 1.5, Infinity]) assert.equal(metadata.safeParse([id]).success, false)
  const page = actressIpcSchemas[IPC.ACTRESS_VIDEO_PAGE]
  assert.equal(page.safeParse([1, { withCover: true }]).success, true)
  assert.equal(page.safeParse([1, { withCover: false }]).success, true)
  assert.equal(page.safeParse([1, { withCover: 'true' }]).success, false)
})

it('validates bounded actress gallery pages', () => {
  const page = actressIpcSchemas[IPC.ACTRESS_GALLERY_PAGE]
  assert.equal(page.safeParse([1]).success, true)
  assert.equal(page.safeParse([1, { limit: 100, offset: 60 }]).success, true)
  assert.equal(page.safeParse([1, { anchorId: 77 }]).success, true)
  for (const anchorId of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '77']) assert.equal(page.safeParse([1, { anchorId }]).success, false)
  for (const args of [[0], [1, { limit: 101 }], [1, { offset: -1 }], [1, { offset: Number.MAX_SAFE_INTEGER + 1 }], [1, { sort: 'position' }]]) {
    assert.equal(page.safeParse(args).success, false)
  }
})

it('validates a profile header identity without optional wide-data flags', () => {
  const schema = actressIpcSchemas[IPC.ACTRESS_PROFILE]
  assert.equal(schema.safeParse([1]).success, true)
  for (const args of [[0], [-1], [1.5], [Infinity], [1, { gallery: true }]]) assert.equal(schema.safeParse(args).success, false)
})

it('validates the optional local photo source filter', () => {
  const page = actressIpcSchemas[IPC.ACTRESS_GALLERY_PAGE]
  assert.equal(page.safeParse([1, { localOnly: true }]).success, true)
  assert.equal(page.safeParse([1, { localOnly: false }]).success, true)
  assert.equal(page.safeParse([1, { localOnly: 'true' }]).success, false)
})
