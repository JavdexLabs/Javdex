import fs from 'node:fs'
import path from 'node:path'

export type WritableLocalPathState = 'present' | 'missing' | 'unknown'

export interface WritableLocalPathInspection {
  state: WritableLocalPathState
  deviceId: number | null
}

export function inspectWritableLocalPath(
  filePath: string,
  options: {
    expectedDeviceId?: number
    acceptPresentDeviceChange?: boolean
  } = {}
): WritableLocalPathInspection {
  try {
    const deviceId = fs.lstatSync(filePath).dev
    const expected = options.expectedDeviceId
    if (
      expected != null &&
      deviceId !== expected &&
      !options.acceptPresentDeviceChange
    ) {
      return { state: 'unknown', deviceId }
    }
    return { state: 'present', deviceId }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return { state: 'unknown', deviceId: null }
    }
  }

  try {
    const parent = path.dirname(filePath)
    const parentStat = fs.statSync(parent)
    if (!parentStat.isDirectory()) return { state: 'unknown', deviceId: parentStat.dev }
    if (
      options.expectedDeviceId != null &&
      parentStat.dev !== options.expectedDeviceId
    ) {
      return { state: 'unknown', deviceId: parentStat.dev }
    }
    fs.accessSync(parent, fs.constants.R_OK | fs.constants.W_OK)
    return { state: 'missing', deviceId: parentStat.dev }
  } catch {
    return { state: 'unknown', deviceId: null }
  }
}
