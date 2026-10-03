import { z } from 'zod'
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const presentation = z.enum(['expanded', 'docked', 'fullscreen'])
export const playbackTargetSchema = z.object({ libraryId: id, videoId: id, resourceId: id }).strict()
export const playbackOpenOptionsSchema = z.object({ privateSession: z.boolean().optional() }).strict()
export const playbackClearProgressSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }).strict(),
  z.object({ scope: z.literal('current'), sessionId: z.string().uuid() }).strict()
])
export const playbackSessionIdSchema = z.string().uuid()
export const playbackControlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pause'), paused: z.boolean() }).strict(),
  z.object({ kind: z.literal('seek'), seconds: z.number().finite().min(-604800).max(604800), relative: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('volume'), value: z.number().finite().min(0).max(100) }).strict(),
  z.object({ kind: z.literal('mute'), muted: z.boolean() }).strict(),
  z.object({ kind: z.literal('speed'), value: z.union([z.literal(0.5), z.literal(0.75), z.literal(1), z.literal(1.25), z.literal(1.5), z.literal(2)]) }).strict(),
  z.object({ kind: z.literal('track'), type: z.enum(['audio', 'sub']), id: id.nullable() }).strict(),
  z.object({ kind: z.literal('subtitle-delay'), seconds: z.number().finite().min(-60).max(60) }).strict(),
  z.object({ kind: z.literal('subtitle-size'), value: z.number().finite().min(10).max(100) }).strict(),
  z.object({ kind: z.literal('presentation'), value: presentation }).strict(),
  z.object({ kind: z.literal('restart') }).strict(),
  z.object({ kind: z.literal('resume'), choice: z.enum(['continue', 'start']) }).strict(),
  z.object({ kind: z.literal('private-session') }).strict(),
  z.object({ kind: z.literal('stop') }).strict()
])
const coordinate = z.number().finite().min(0).max(32768)
export const playbackViewportSchema = z.object({
  sessionId: playbackSessionIdSchema,
  presentationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  presentation,
  rect: z.object({ x: coordinate, y: coordinate, width: coordinate, height: coordinate }).strict(),
  visible: z.boolean()
}).strict()
