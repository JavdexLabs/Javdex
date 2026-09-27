import { z } from 'zod'
import type { RelatedLinkInput } from './relatedLinkTypes'
import { aggregateVersionSchema } from './manage/primitives'

export type PlaylistImportEntry = (
  | { kind: 'existing'; videoId: number }
  | { kind: 'create'; code: string; title: string | null }
) & { links?: RelatedLinkInput[] }

export interface PlaylistImportWriteInput {
  destination: { kind: 'create'; name: string; coverPath?: string | null } | { kind: 'append'; playlistId: number }
  libraryId: number
  entries: PlaylistImportEntry[]
  sourceLinks?: RelatedLinkInput[]
  /** Local reuse preserves existing ownership; remote import explicitly adds the destination. */
  reusedMembership: 'preserve' | 'ensure-target'
}

export const playlistApplyImportResultSchema = z.object({
  playlistId: z.number(), added: z.number(), relatedLinksAdded: z.number(),
  entries: z.array(z.object({
    videoId: z.number(),
    created: z.boolean(),
    membershipAdded: z.boolean(),
    addedToPlaylist: z.boolean(),
    alreadyInPlaylist: z.boolean(),
    relatedLinksAdded: z.number()
  }).strict()).optional(),
  versions: z.object({
    P: aggregateVersionSchema,
    L: aggregateVersionSchema.extend({ generation: z.literal(1) }),
    V: aggregateVersionSchema.optional()
  })
})
export type PlaylistApplyImportResult = z.infer<typeof playlistApplyImportResultSchema>
