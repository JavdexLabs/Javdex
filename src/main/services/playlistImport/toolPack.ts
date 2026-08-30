import {
  createAgentBrowserSchema,
  strictObjectSchema,
  type AgentToolInputSchema
} from '../../agent-platform/agentBrowserSchema'
import type { HostedToolResult } from '../../agent-platform/types'
import type { ToolHandler, ToolPack } from '../../agent-platform/toolHost'

const shortText = (maxLength: number): Record<string, unknown> => ({ type: 'string', maxLength })

function readOnlyBrowserSchema(): ReturnType<typeof createAgentBrowserSchema> {
  const schema = createAgentBrowserSchema()
  const denied = new Set(['open', 'click', 'scroll'])
  return {
    ...schema,
    oneOf: schema.oneOf?.filter((actionSchema) => {
      const action = actionSchema.properties?.action as { enum?: unknown[] } | undefined
      return !denied.has(String(action?.enum?.[0] ?? ''))
    })
  }
}

const extractionSchema = strictObjectSchema({
  candidateSelector: shortText(1_000),
  detailLinkSelector: shortText(1_000),
  detailLinkAttribute: shortText(160),
  codeSelector: shortText(1_000),
  codeAttribute: shortText(160),
  codePattern: shortText(256),
  titleSelector: shortText(1_000),
  titleAttribute: shortText(160)
}, ['candidateSelector', 'detailLinkSelector'])

const terminalWithSelectorAdvanceSchema = strictObjectSchema({
  kind: { type: 'string', enum: ['terminal'] },
  selector: shortText(1_000),
  reason: {
    type: 'string',
    enum: [
      'disabled-next',
      'explicit-last-page',
      'no-pagination-container-after-full-dom-check'
    ]
  }
}, ['kind', 'reason', 'selector'])

const knownTotalTerminalAdvanceSchema = strictObjectSchema({
  kind: { type: 'string', enum: ['terminal'] },
  reason: { type: 'string', enum: ['known-total-reached'] }
}, ['kind', 'reason'])

const linkAdvanceSchema = strictObjectSchema({
  kind: { type: 'string', enum: ['next-link', 'numbered-links'] },
  selector: shortText(1_000)
}, ['kind', 'selector'])

const terminalOrLinkAdvanceSchema: AgentToolInputSchema = {
  type: 'object',
  oneOf: [
    terminalWithSelectorAdvanceSchema,
    knownTotalTerminalAdvanceSchema,
    linkAdvanceSchema
  ]
}

const loadMoreExhaustedTerminalSchema = strictObjectSchema({
  kind: { type: 'string', enum: ['terminal'] },
  reason: { type: 'string', enum: ['load-more-control-exhausted'] }
}, ['kind', 'reason'])

const loadMoreAfterExhaustedSchema: AgentToolInputSchema = {
  type: 'object',
  oneOf: [loadMoreExhaustedTerminalSchema, linkAdvanceSchema]
}

const loadMoreAdvanceSchema = strictObjectSchema({
  kind: { type: 'string', enum: ['load-more'] },
  selector: shortText(1_000),
  afterExhausted: loadMoreAfterExhaustedSchema
}, ['kind', 'selector', 'afterExhausted'])

const advanceSchema: AgentToolInputSchema = {
  type: 'object',
  oneOf: [
    ...(terminalOrLinkAdvanceSchema.oneOf ?? []),
    loadMoreAdvanceSchema
  ]
}

const unsupportedFailureSchema: AgentToolInputSchema = {
  type: 'object',
  oneOf: [
    strictObjectSchema({
      code: { type: 'string', enum: ['UNSUPPORTED_LIST_STRUCTURE'] },
      reason: {
        type: 'string',
        enum: [
          'missing-stable-position',
          'inaccessible-list-structure',
          'cross-origin-frame',
          'custom-scroll-without-metrics'
        ]
      },
      documentRevision: shortText(160),
      viewRevision: shortText(160),
      evidenceRef: shortText(512)
    }, ['code', 'reason', 'documentRevision', 'viewRevision', 'evidenceRef']),
    strictObjectSchema({
      code: { type: 'string', enum: ['UNSUPPORTED_PAGINATION'] },
      reason: {
        type: 'string',
        enum: [
          'no-provable-terminal',
          'unsupported-cursor-pagination',
          'unbounded-feed',
          'continuity-unprovable'
        ]
      },
      documentRevision: shortText(160),
      viewRevision: shortText(160),
      evidenceRef: shortText(512)
    }, ['code', 'reason', 'documentRevision', 'viewRevision', 'evidenceRef']),
    strictObjectSchema({
      code: { type: 'string', enum: ['SCROLL_LOOP'] },
      reason: { type: 'string', enum: ['repeated-scroll-state'] },
      documentRevision: shortText(160),
      viewRevision: shortText(160),
      evidenceRef: shortText(512)
    }, ['code', 'reason', 'documentRevision', 'viewRevision', 'evidenceRef'])
  ]
}

export const PLAYLIST_IMPORTER_TOOL_PACK: ToolPack = {
  ref: 'toolpack:playlist-importer:v1',
  tools: [
    {
      name: 'browser',
      label: '检查当前清单或详情页',
      description: '只读检查当前页面。导航、点击分页和滚动由清单导入宿主工具执行。',
      schema: readOnlyBrowserSchema(),
      capability: 'browser.read',
      effect: 'network',
      executionMode: 'sequential',
      timeoutMs: 45_000,
      resourceKey: () => 'playlist-import-browser',
      redact: (args) => ({ action: args.action })
    },
    {
      name: 'checkpoint_playlist_page',
      label: '固化当前清单页',
      description: '提交当前清单页的完整 selector 方案；宿主从活页面全量提取并固化候选后才允许离开。',
      schema: strictObjectSchema({
        kind: {
          type: 'string',
          enum: ['static-page', 'virtual-page-start', 'load-more-page-start']
        },
        evidenceRef: shortText(512),
        suggestedPlaylistName: shortText(500),
        extraction: extractionSchema,
        advance: advanceSchema,
        declaredTotalItems: { type: 'number', minimum: 0 },
        declaredTotalPages: { type: 'number', minimum: 1 },
        enumeration: strictObjectSchema({
          containerSelector: shortText(1_000),
          positionKind: { type: 'string', enum: ['aria-posinset', 'attribute'] },
          positionAttribute: shortText(160),
          positionBase: { type: 'integer', enum: [0, 1] }
        }, ['positionKind'])
      }, ['kind', 'evidenceRef', 'extraction', 'advance']),
      capability: 'playlist-import.stage-page',
      effect: 'write',
      executionMode: 'sequential',
      timeoutMs: 30_000,
      resourceKey: () => 'playlist-import-staging',
      redact: (args) => ({ kind: args.kind, evidenceRef: args.evidenceRef })
    },
    {
      name: 'advance_playlist_page',
      label: '进入下一清单窗口',
      description: '由宿主执行已固化的下一页导航、一次“加载更多”点击或一次虚拟列表半屏滚动，并在返回前落盘新窗口。',
      schema: strictObjectSchema({}),
      capability: 'playlist-import.stage-page',
      effect: 'write',
      executionMode: 'sequential',
      timeoutMs: 45_000,
      resourceKey: () => 'playlist-import-staging',
      redact: () => ({})
    },
    {
      name: 'report_playlist_import_failure',
      label: '报告不支持的清单结构',
      description: '当前页面无法被 V1 安全、完整遍历时，以受控错误码和当前页面证据明确终止；不得用它跳过可读取页面。',
      schema: unsupportedFailureSchema,
      capability: 'playlist-import.stage-page',
      effect: 'write',
      executionMode: 'sequential',
      timeoutMs: 30_000,
      resourceKey: () => 'playlist-import-staging',
      redact: (args) => ({ code: args.code, reason: args.reason, evidenceRef: args.evidenceRef })
    },
    {
      name: 'open_playlist_item_detail',
      label: '打开待确认影片详情',
      description: '由宿主打开状态机当前唯一允许的详情页；发现阶段结束前不可调用。',
      schema: strictObjectSchema({}),
      capability: 'playlist-import.stage-identity',
      effect: 'network',
      executionMode: 'sequential',
      timeoutMs: 45_000,
      resourceKey: () => 'playlist-import-browser',
      redact: () => ({})
    },
    {
      name: 'checkpoint_playlist_detail',
      label: '固化当前影片身份',
      description: '一次提交当前详情页明确展示的身份事实；匹配结果由宿主重算，不接受候选 ID。',
      schema: strictObjectSchema({
        itemId: { type: 'number', minimum: 1 },
        expectedItemRevision: { type: 'number', minimum: 1 },
        documentRevision: shortText(160),
        viewRevision: shortText(160),
        detailCode: shortText(100),
        identity: strictObjectSchema({
          publisher: shortText(500),
          releaseDate: shortText(80),
          source: shortText(160),
          externalCode: shortText(500),
          sourceUrl: shortText(4_096)
        }),
        evidenceRef: shortText(512)
      }, [
        'itemId', 'expectedItemRevision', 'documentRevision', 'viewRevision',
        'identity', 'evidenceRef'
      ]),
      capability: 'playlist-import.stage-identity',
      effect: 'write',
      executionMode: 'sequential',
      timeoutMs: 30_000,
      resourceKey: () => 'playlist-import-staging',
      redact: (args) => ({
        itemId: args.itemId,
        expectedItemRevision: args.expectedItemRevision,
        evidenceRef: args.evidenceRef
      })
    }
  ]
}

export function createPlaylistImporterToolHandlers(input: {
  browser: (
    args: Record<string, unknown>, signal: AbortSignal, callId: string
  ) => Promise<HostedToolResult>
  checkpointPage: (
    args: Record<string, unknown>, signal: AbortSignal, callId: string
  ) => Promise<HostedToolResult>
  advancePage: (
    args: Record<string, unknown>, signal: AbortSignal, callId: string
  ) => Promise<HostedToolResult>
  reportFailure: (
    args: Record<string, unknown>, signal: AbortSignal, callId: string
  ) => Promise<HostedToolResult>
  openItemDetail: (
    args: Record<string, unknown>, signal: AbortSignal, callId: string
  ) => Promise<HostedToolResult>
  checkpointDetail: (
    args: Record<string, unknown>, signal: AbortSignal, callId: string
  ) => Promise<HostedToolResult>
}): ReadonlyMap<string, ToolHandler> {
  return new Map([
    ['browser', ({ args, signal, callId }) => input.browser(args, signal, callId)],
    ['checkpoint_playlist_page', ({ args, signal, callId }) => (
      input.checkpointPage(args, signal, callId)
    )],
    ['advance_playlist_page', ({ args, signal, callId }) => (
      input.advancePage(args, signal, callId)
    )],
    ['report_playlist_import_failure', ({ args, signal, callId }) => (
      input.reportFailure(args, signal, callId)
    )],
    ['open_playlist_item_detail', ({ args, signal, callId }) => (
      input.openItemDetail(args, signal, callId)
    )],
    ['checkpoint_playlist_detail', ({ args, signal, callId }) => (
      input.checkpointDetail(args, signal, callId)
    )]
  ])
}
