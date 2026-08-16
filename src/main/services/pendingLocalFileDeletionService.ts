import fs from 'node:fs'
import {
  listPendingLocalFileDeletions,
  removePendingLocalFileDeletions
} from '../db/pendingLocalFileDeletionRepo'
import { inspectWritableLocalPath } from './localFileAvailability'

export interface PendingLocalFileDeletionRecoveryResult {
  cleaned: number
  restored: number
  failed: number
}

/** Recover interrupted pre-commit staging and retry committed physical deletions. */
export function recoverPendingLocalFileDeletions(): PendingLocalFileDeletionRecoveryResult {
  const result: PendingLocalFileDeletionRecoveryResult = { cleaned: 0, restored: 0, failed: 0 }
  for (const entry of listPendingLocalFileDeletions()) {
    try {
      const stagedInspection = inspectWritableLocalPath(entry.staged_path, {
        expectedDeviceId: entry.device_id,
        acceptPresentDeviceChange: true
      })
      const stagedState = stagedInspection.state
      if (entry.state === 'prepared') {
        if (stagedState === 'present') {
          const originalState = inspectWritableLocalPath(entry.original_path, {
            expectedDeviceId: stagedInspection.deviceId ?? entry.device_id
          }).state
          if (originalState === 'unknown') throw new Error('原文件所在存储当前不可用')
          if (originalState === 'present') {
            throw new Error('原路径已被占用，无法恢复暂存文件')
          }
          fs.renameSync(entry.staged_path, entry.original_path)
          result.restored += 1
        } else {
          const originalState = inspectWritableLocalPath(entry.original_path, {
            expectedDeviceId: entry.device_id
          }).state
          if (originalState !== 'present') {
            throw new Error(
              originalState === 'unknown'
                ? '原文件所在存储当前不可用'
                : '暂存文件和原文件均不存在'
            )
          }
        }
      } else {
        if (stagedState === 'unknown') throw new Error('暂存文件所在存储当前不可用')
        if (stagedState === 'present') {
          fs.unlinkSync(entry.staged_path)
          result.cleaned += 1
        }
      }
      removePendingLocalFileDeletions([entry.staged_path])
    } catch (error) {
      result.failed += 1
      console.error('Failed to recover pending local file deletion:', entry.staged_path, error)
    }
  }
  return result
}
