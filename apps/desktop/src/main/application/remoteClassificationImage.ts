import type { ClassificationImageInput } from '@shared/classificationTypes'
import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { CatalogBackend } from './catalogBackend'
import { uploadCatalogImageSource } from './remoteCatalogImage'

export async function remoteClassificationImage(
  backend: CatalogBackend,
  input: ClassificationImageInput | null
): Promise<CatalogImageRef | { kind: 'videoCover'; videoId: number }> {
  if (!input) return { kind: 'clear' }
  if (input.source === 'video-cover') return { kind: 'videoCover', videoId: input.videoId }
  return uploadCatalogImageSource(backend, 'classificationImage', input)
}
