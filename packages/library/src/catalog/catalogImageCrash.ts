export const IMAGE_CRASH_POINTS = [
  'afterPersistUploadRow',
  'beforeWriteFile',
  'afterWriteFile',
  'beforeRefCommit',
  'afterRefCommit',
  'beforeOldDelete',
  'afterOldDelete'
] as const

export type ImageCrashPoint = (typeof IMAGE_CRASH_POINTS)[number]

const hooks = new Map<ImageCrashPoint, () => void>()

export function setImageCrashHook(point: ImageCrashPoint, hook: (() => void) | null): void {
  if (hook) hooks.set(point, hook)
  else hooks.delete(point)
}

export function clearImageCrashHooks(): void {
  hooks.clear()
}

export function maybeCrashImageFlow(point: ImageCrashPoint): void {
  if (process.env.JAVDEX_IMAGE_CRASH === point) {
    process.exit(75)
  }
  hooks.get(point)?.()
}
