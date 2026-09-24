import fs from 'node:fs'
import { structuredError } from '@shared/protocol/errors'
import { resolveLibraryMediaMounts } from '@library/runtime/host'

export function resolveMountSelectionPath(mountSelectionId: string): string {
  const mounts = resolveLibraryMediaMounts()
  const configured = mounts[mountSelectionId]
  if (!configured) {
    throw structuredError('INVALID_INPUT', '未知的媒体挂载选择', {
      field: 'root.mountSelectionId'
    })
  }
  if (!fs.existsSync(configured)) {
    throw structuredError('INVALID_INPUT', '媒体挂载不存在或已卸载')
  }
  return fs.realpathSync.native(configured)
}
