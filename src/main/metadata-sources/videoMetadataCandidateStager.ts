import type { PendingVideoScrapeCandidateInput } from '../db/pendingVideoScrapeRepo'
import { mediaAssetStore, type MediaAssetStore } from '../services/mediaAssetStore'
import type { MetadataAssetRef, VideoMetadataCandidateStager } from './types'

interface VideoMetadataCandidateStagerDependencies {
  fetchRemote: (url: string) => Promise<Buffer>
  readManagedRootFile?: (
    capability: Extract<MetadataAssetRef, { kind: 'managed-root-file' }>['capability']
  ) => Promise<Buffer>
  assetStore?: Pick<
    MediaAssetStore,
    | 'isUsableImageBuffer'
    | 'stageVideoScrapeImages'
    | 'downloadCover'
    | 'downloadAvatar'
    | 'downloadSamples'
    | 'deleteBestEffort'
  >
}

function safeAssetReference(asset: MetadataAssetRef): string {
  if (asset.kind === 'remote-url') return asset.url
  const filename = asset.filename.replaceAll('\\', '/').split('/').at(-1) || 'asset.jpg'
  return `managed-root-file:${asset.field}-${asset.position}:${encodeURIComponent(filename)}`
}

function persistedAssetReference(asset: MetadataAssetRef): string {
  return asset.kind === 'remote-url' ? asset.url : ''
}

export function createVideoMetadataCandidateStager(
  dependencies: VideoMetadataCandidateStagerDependencies
): VideoMetadataCandidateStager {
  const assetStore = dependencies.assetStore ?? mediaAssetStore

  const readAsset = async (asset: MetadataAssetRef): Promise<Buffer> => {
    if (asset.kind === 'remote-url') return dependencies.fetchRemote(asset.url)
    if (!dependencies.readManagedRootFile) {
      throw new Error('本地候选资源读取能力不可用')
    }
    return dependencies.readManagedRootFile(asset.capability)
  }

  const readUsableAsset = async (asset: MetadataAssetRef): Promise<Buffer | null> => {
    try {
      const data = await readAsset(asset)
      return assetStore.isUsableImageBuffer(data) ? data : null
    } catch {
      return null
    }
  }

  return {
    async stageForPending(candidates) {
      const warnings: string[] = []
      const stagedCandidates: PendingVideoScrapeCandidateInput[] = []
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const resources: Parameters<typeof assetStore.stageVideoScrapeImages>[0] = []
        const cover = candidate.assets.find((asset) => asset.field === 'cover')
        if (cover) {
          const data = await readUsableAsset(cover)
          if (data) {
            resources.push({
              field: 'cover',
              position: 0,
              remoteUrl: persistedAssetReference(cover),
              data
            })
          } else {
            warnings.push(`候选 ${candidateIndex + 1} 的封面暂存失败`)
          }
        }

        const samples = candidate.assets
          .filter((asset) => asset.field === 'samples')
          .sort((left, right) => left.position - right.position)
        if (samples.length > 0) {
          const sampleBuffers = await Promise.all(samples.map(readUsableAsset))
          if (sampleBuffers.every((data): data is Buffer => data !== null)) {
            sampleBuffers.forEach((data, position) => {
              resources.push({
                field: 'samples',
                position,
                remoteUrl: persistedAssetReference(samples[position]),
                data
              })
            })
          } else {
            warnings.push(`候选 ${candidateIndex + 1} 的样张暂存不完整，已放弃整组样张`)
          }
        }

        const avatars = candidate.assets
          .filter((asset) => asset.field === 'actressAvatar')
          .sort((left, right) => left.position - right.position)
        for (const avatar of avatars) {
          const data = await readUsableAsset(avatar)
          const actress = candidate.result.actresses?.[avatar.position]
          if (data) {
            resources.push({
              field: 'actressAvatar',
              position: avatar.position,
              remoteUrl: persistedAssetReference(avatar),
              data
            })
          } else {
            warnings.push(
              `候选 ${candidateIndex + 1} 的演员「${actress?.name ?? '未知'}」头像暂存失败`
            )
          }
        }

        const staged = assetStore.stageVideoScrapeImages(resources)
        stagedCandidates.push({
          result: candidate.result,
          sourceUrl: candidate.result.sourceUrl ?? null,
          normalizedSourceUrl: candidate.evidence.sourceUrl ?? null,
          resources: staged.map((resource) => ({
            field: resource.field,
            position: resource.position,
            remoteUrl: resource.remoteUrl,
            stagedPath: resource.stagedPath,
            width: resource.width,
            height: resource.height,
            sizeBytes: resource.sizeBytes
          }))
        })
      }
      return { candidates: stagedCandidates, warnings }
    },

    async deliverForApply(candidate, selectedFields, fallbackCode) {
      const selected = new Set(selectedFields)
      let coverRel: string | null = null
      let sampleRels: Array<string | null> = []
      const avatarMap = new Map<string, string | null>()

      const cover = selected.has('cover')
        ? candidate.assets.find((asset) => asset.field === 'cover')
        : undefined
      if (cover) {
        const reference = safeAssetReference(cover)
        coverRel = await assetStore.downloadCover(
          candidate.result.code || fallbackCode,
          reference,
          () => readAsset(cover)
        )
      }

      const wantsFemale = selected.has('actressesFemale')
      const wantsMale = selected.has('actressesMale')
      if (wantsFemale || wantsMale) {
        for (const avatar of candidate.assets.filter(
          (asset) => asset.field === 'actressAvatar'
        )) {
          const actress = candidate.result.actresses?.[avatar.position]
          if (!actress) continue
          const gender = actress.gender ?? 'female'
          if ((gender === 'female' && !wantsFemale) || (gender === 'male' && !wantsMale)) {
            continue
          }
          avatarMap.set(
            actress.name,
            await assetStore.downloadAvatar(
              actress.name,
              safeAssetReference(avatar),
              () => readAsset(avatar)
            )
          )
        }
      }

      if (selected.has('samples')) {
        const samples = candidate.assets
          .filter((asset) => asset.field === 'samples')
          .sort((left, right) => left.position - right.position)
        if (samples.length > 0) {
          const byReference = new Map(samples.map((asset) => [safeAssetReference(asset), asset]))
          const references = samples.map(safeAssetReference)
          sampleRels = await assetStore.downloadSamples(
            candidate.result.code || fallbackCode,
            references,
            (reference) => {
              const asset = byReference.get(reference)
              if (!asset) throw new Error('候选资源引用无效')
              return readAsset(asset)
            }
          )
          if (sampleRels.some((assetPath) => !assetPath)) {
            for (const assetPath of sampleRels) assetStore.deleteBestEffort(assetPath)
            sampleRels = samples.map(() => null)
          }
        }
      }

      return { coverRel, sampleRels, avatarMap }
    }
  }
}
