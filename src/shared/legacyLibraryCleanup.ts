/** Stable persistence markers for cleanup intents imported from pre-library settings. */
export const LEGACY_CLEANUP_JOB_ID_PREFIX = 'legacy-settings-cleanup:'

export const LEGACY_CLEANUP_WAITING_ERROR =
  '旧版待清理根目录当前不可用；连接恢复后将在下一次完整扫描中继续。'

export const LEGACY_CLEANUP_JOB_ID_PATTERN = `${LEGACY_CLEANUP_JOB_ID_PREFIX}%`
