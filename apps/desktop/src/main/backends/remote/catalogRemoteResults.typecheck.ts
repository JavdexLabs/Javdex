import { z } from 'zod'
import { videoLifecycleImpactSchema, videoLifecycleResultSchema } from '@shared/videoLifecycleSchemas'
import type { CatalogResultSchemas } from './catalogRemoteResults'

// These assignments must fail: operation names constrain the parsed output,
// including the wire-to-application adaptation for actresses.edit.
const invalid: CatalogResultSchemas = {
  // @ts-expect-error a preview cannot return a mutation result
  'videos.previewDeleteGlobal': videoLifecycleResultSchema,
  // @ts-expect-error a mutation cannot return a preview
  'videos.deleteGlobal': videoLifecycleImpactSchema,
  // @ts-expect-error application result is boolean, not the wire envelope
  'actresses.edit': z.object({ ok: z.boolean() })
}
void invalid
