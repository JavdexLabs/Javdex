import { authorizeMediaLibraryRootFile } from '@library/scan/mediaLibraryRootFileGuard'
import { createNfoFileStore } from './nfoFileStore'
import { locateNfoSidecar } from './nfoSidecarLocator'
import { parseNfoArtifact } from './nfoArtifactCodec'
import type { LocalNfoAnchor, LocalNfoIdentityInspection } from './localNfoTypes'
import type { LocalNfoScanApplyResult, LocalNfoScanService } from '@library/scan/nfoScanPort'

const fileStore = createNfoFileStore({
  authorize: (filePath, root) => {
    authorizeMediaLibraryRootFile(root.libraryId, root.id, filePath, root)
  }
})

function notifyApply(
  beforeCommit: ((result: LocalNfoScanApplyResult) => void) | undefined,
  result: LocalNfoScanApplyResult
): LocalNfoScanApplyResult {
  const returned: unknown = beforeCommit?.(result)
  if (
    returned != null &&
    typeof returned === 'object' &&
    typeof (returned as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(returned).catch(() => {})
    throw new Error('NFO commit callback must be synchronous')
  }
  return result
}

/** Node/server NFO scan port: identity inspect only. Sidecar field apply stays desktop/S10. */
export function createLibraryLocalNfoScanService(): LocalNfoScanService {
  const service: LocalNfoScanService = {
    inspectIdentity(anchor: LocalNfoAnchor): LocalNfoIdentityInspection {
      const located = locateNfoSidecar({
        anchorPath: anchor.anchorPath,
        root: anchor.root,
        directoryVideoCodes: anchor.directoryVideoCodes,
        directorySidecars: anchor.directorySidecars,
        fileStore
      })
      const warnings = located.warnings.map((warning) => warning.message)
      if (located.status === 'missing') return { status: 'missing', code: null, warnings: [] }
      if (located.status !== 'found' || !located.capability) {
        return { status: 'warning', code: null, warnings }
      }
      try {
        const parsed = parseNfoArtifact(fileStore.readBytes(located.capability))
        return {
          status: 'found',
          code: parsed.model.code,
          warnings: [...warnings, ...parsed.warnings.map((warning) => warning.message)]
        }
      } catch (error) {
        return {
          status: 'warning',
          code: null,
          warnings: [...warnings, error instanceof Error ? error.message : 'NFO 文件无法读取']
        }
      }
    },

    async apply(_videoId, _code, anchors, beforeCommit) {
      const warnings: string[] = []
      let found = false
      for (const anchor of anchors) {
        const inspection = service.inspectIdentity(anchor)
        warnings.push(...inspection.warnings)
        if (inspection.status === 'found') found = true
      }
      if (!found) return notifyApply(beforeCommit, { disposition: 'none', warnings })
      return notifyApply(beforeCommit, {
        disposition: 'skipped',
        warnings: [
          ...warnings,
          '服务端扫描只做本地 NFO 身份检查，不应用 sidecar 资料（封面/刮削应用仍在桌面）。'
        ]
      })
    }
  }
  return service
}

export const libraryLocalNfoScanService = createLibraryLocalNfoScanService()
