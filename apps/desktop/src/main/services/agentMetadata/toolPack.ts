import type { AgentMetadataDraftPayload } from '@shared/agentMetadataTypes'
import { ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/actressScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import type { HostedToolResult } from '../../agent-platform/types'
import { createAgentBrowserSchema, strictObjectSchema } from '../../agent-platform/agentBrowserSchema'
import type { ToolHandler, ToolPack } from '../../agent-platform/toolHost'

const text = (maxLength = 2_000): Record<string, unknown> => ({ type: 'string', maxLength })
const optionalNumber = (minimum = 0, maximum = 10_000): Record<string, unknown> => ({
  type: 'number', minimum, maximum
})
const stringArray = (maxItems: number, maxLength = 400): Record<string, unknown> => ({
  type: 'array',
  maxItems,
  items: { type: 'string', maxLength }
})

const scrapedActressSchema = strictObjectSchema({
  name: text(200),
  avatarUrl: text(4_096),
  gender: { type: 'string', enum: ['female', 'male'] }
}, ['name'])

const videoDataSchema = strictObjectSchema({
  code: text(100),
  title: text(1_000),
  summary: text(20_000),
  coverUrl: text(4_096),
  releaseDate: text(100),
  maker: text(500),
  publisher: text(500),
  series: text(500),
  director: text(500),
  durationSeconds: optionalNumber(0, 86_400),
  ratingAverage: optionalNumber(0, 5),
  ratingCount: optionalNumber(0, 1_000_000_000),
  sampleImageUrls: stringArray(80, 4_096),
  actresses: { type: 'array', maxItems: 120, items: scrapedActressSchema },
  tags: stringArray(200, 300)
}, ['code'])

const actressDataSchema = strictObjectSchema({
  mainName: text(300),
  nameZh: text(300),
  nameEn: text(300),
  avatarUrl: text(4_096),
  birthDate: text(100),
  debutDate: text(100),
  heightCm: optionalNumber(0, 300),
  bustCm: optionalNumber(0, 300),
  waistCm: optionalNumber(0, 300),
  hipCm: optionalNumber(0, 300),
  cupSize: text(20),
  bloodType: text(20),
  zodiac: text(100),
  nationality: text(200),
  profileSummary: text(20_000),
  galleryImageUrls: stringArray(120, 4_096),
  aliases: stringArray(120, 300)
})

const submitSchema = {
  type: 'object',
  oneOf: [
    strictObjectSchema({
      kind: { type: 'string', enum: ['video'] },
      observedFields: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ALL_VIDEO_SCRAPE_FIELDS } },
      explicitlyEmptyFields: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ALL_VIDEO_SCRAPE_FIELDS } },
      data: videoDataSchema,
      evidenceRefs: { ...stringArray(80, 512), minItems: 1 }
    }, ['kind', 'observedFields', 'explicitlyEmptyFields', 'data', 'evidenceRefs']),
    strictObjectSchema({
      kind: { type: 'string', enum: ['actress'] },
      observedFields: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ALL_ACTRESS_SCRAPE_FIELDS } },
      explicitlyEmptyFields: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ALL_ACTRESS_SCRAPE_FIELDS } },
      identityMatched: { type: 'boolean' },
      data: actressDataSchema,
      evidenceRefs: { ...stringArray(80, 512), minItems: 1 }
    }, ['kind', 'observedFields', 'explicitlyEmptyFields', 'identityMatched', 'data', 'evidenceRefs'])
  ]
}

export const AGENT_METADATA_COLLECTOR_TOOL_PACK: ToolPack = {
  ref: 'toolpack:metadata-collector:v1',
  tools: [
    {
      name: 'browser',
      label: '浏览详情页',
      description: '打开并检查外部详情页。只允许读取、点击展开内容；需要用户验证或登录时使用 handoff。',
      schema: createAgentBrowserSchema(),
      capability: 'browser.read',
      effect: 'network',
      executionMode: 'sequential',
      timeoutMs: 45_000,
      resourceKey: () => 'metadata-browser',
      redact: (args) => {
        if (typeof args.url !== 'string') return args
        try {
          const url = new URL(args.url)
          return { ...args, url: `${url.origin}${url.pathname}` }
        } catch {
          return { ...args, url: '[invalid-url]' }
        }
      }
    },
    {
      name: 'submit_metadata_candidate',
      label: '提交并暂存元数据候选',
      description: '提交一次经过身份核对的影片或演员元数据候选；宿主会联网下载候选图片并写入临时草稿，但不会直接修改媒体库。',
      schema: submitSchema,
      capability: 'metadata.stage-remote-candidate',
      effect: 'network',
      executionMode: 'sequential',
      timeoutMs: 60_000,
      resourceKey: () => 'metadata-draft',
      redact: (args) => ({
        kind: args.kind,
        observedFields: args.observedFields,
        explicitlyEmptyFields: args.explicitlyEmptyFields,
        evidenceRefCount: Array.isArray(args.evidenceRefs) ? args.evidenceRefs.length : 0
      })
    }
  ]
}

export function createAgentMetadataToolHandlers(input: {
  browser: (
    args: Record<string, unknown>,
    signal: AbortSignal,
    callId: string
  ) => Promise<HostedToolResult>
  submit: (
    args: Record<string, unknown>,
    signal: AbortSignal,
    callId: string
  ) => Promise<AgentMetadataDraftPayload>
}): ReadonlyMap<string, ToolHandler> {
  return new Map([
    ['browser', async ({ args, signal, callId }) => input.browser(args, signal, callId)],
    ['submit_metadata_candidate', async ({ args, signal, callId }) => {
      const payload = await input.submit(args, signal, callId)
      return {
        ok: true,
        content: JSON.stringify({ ok: true, kind: payload.kind, message: '候选已保存，等待用户预览确认。' }),
        summary: '元数据候选已保存',
        terminate: true,
        recovery: { kind: payload.kind }
      }
    }]
  ])
}
