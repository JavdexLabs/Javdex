import { setCloseToTrayEnabled } from '../appTray'
import { webAccess } from '../web/webAccess'
import { dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { AppSettings, SettingsSnapshot } from '@shared/settingsTypes'
import type { AssetCryptoProgress, LibraryOverviewStats } from '@shared/libraryTypes'
import {
  getLlmSecretMigrationError,
  getSettings,
  getSettingsRecoveryBackupPath,
  getSettingsRecoveryNotice,
  updateSettings
} from '../settings/settingsStore'
import { getLibraryOverviewStats } from '@library/db/overviewRepo'
import { migrateAssetStorage } from '../services/assetMigration'
import { prepareMediaAssetsLocationMigration } from '../services/assetLocationMigration'
import { mediaAssetStore } from '../services/mediaAssetStore'
import {
  defaultMediaAssetsRoot,
  resolveMediaAssetsRoot,
  validateMediaAssetsPath
} from '../services/assetStoragePaths'
import { testProxyConnection } from '../services/proxyConnectionTest'
import { translateTextToChinese } from '../services/llmTextTranslate'
import {
  confirmLibraryPathRemoval,
  previewLibraryPathRemoval
} from '../services/libraryPathCleanupService'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import { getLlmSecretStorageState } from '../settings/llmSecretStore'
import { isScraperPluginRunnable } from '../scrapers/scraperPluginService'
import { ModelManagementError, modelManagement } from '../agent-platform/modelManagement'

function toSettingsSnapshot(settings: AppSettings): SettingsSnapshot {
  const {
    defaultLlmProviderId: _defaultLlmProviderId,
    defaultLlmModelId: _defaultLlmModelId,
    llmProviderConfigs: _llmProviderConfigs,
    customLlmProviders: _customLlmProviders,
    llmCustomModels: _llmCustomModels,
    pluginDevAgentMaxTurns: _pluginDevAgentMaxTurns,
    pluginDevAgentMaxContextTokens: _pluginDevAgentMaxContextTokens,
    ...publicSettings
  } = settings
  return {
    ...publicSettings,
    mediaAssetsResolvedPath: resolveMediaAssetsRoot(),
    recoveryNotice: getSettingsRecoveryNotice(),
    llmSecretStorage: {
      ...getLlmSecretStorageState(),
      ...(getLlmSecretMigrationError()
        ? { migrationError: getLlmSecretMigrationError() }
        : {})
    }
  }
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  appCommandAdapter.register(IPC.WEB_ACCESS_PAIR_OPEN, () => webAccess.openPairing())
  appCommandAdapter.register(IPC.WEB_ACCESS_PAIR_INSPECT, (code) => webAccess.inspectPair(code))
  appCommandAdapter.register(IPC.WEB_ACCESS_PAIR_DECIDE, (code, approve) => webAccess.decidePair(code, approve))
  appCommandAdapter.register(IPC.WEB_ACCESS_DEVICE_REMOVE, (id) => webAccess.removeDevice(id))
  appCommandAdapter.register(IPC.WEB_ACCESS_DEVICE_RENAME, (id, name) => webAccess.renameDevice(id, name))
  appCommandAdapter.register(IPC.WEB_ACCESS_DEVICE_RESET, () => webAccess.resetDevices())
  appCommandAdapter.register(IPC.WEB_ACCESS_STATUS, () => webAccess.status())
  appCommandAdapter.register(IPC.WEB_ACCESS_APPLY, (input) => webAccess.apply(input))
  appCommandAdapter.register(IPC.WEB_ACCESS_REVOKE, () => webAccess.revoke())
  appCommandAdapter.register(IPC.SETTINGS_GET, (): SettingsSnapshot => toSettingsSnapshot(getSettings()))

  appCommandAdapter.register(IPC.SETTINGS_OVERVIEW_STATS, (): LibraryOverviewStats => getLibraryOverviewStats())

  appCommandAdapter.register(IPC.SETTINGS_UPDATE, (patch): SettingsSnapshot => {
    const rawPatch = patch as Partial<AppSettings>
    const {
      assetEncryption: _ignoredCrypto,
      mediaAssetsPath: _ignoredPath,
      pendingLibraryPathCleanups: _ignoredCleanupQueue,
      lastLibraryScanSummary: _ignoredScanSummary,
      unrecognizedFiles: _ignoredUnrecognizedFiles,
      unrecognizedFilesScanFinishedAt: _ignoredUnrecognizedFilesScanFinishedAt,
      libraryPaths: _ignoredLibraryPaths,
      autoDeleteResourceLessVideos: _ignoredResourceLessPolicy,
      autoScanEnabled: _ignoredAutoScan,
      autoScanIntervalMinutes: _ignoredAutoScanInterval,
      minScanImportDurationMinutes: _ignoredMinimumDuration,
      autoMergeSameCodeResources: _ignoredAutoMerge,
      defaultLlmProviderId: _ignoredDefaultLlmProviderId,
      defaultLlmModelId: _ignoredDefaultLlmModelId,
      llmProviderConfigs: _ignoredLlmProviderConfigs,
      customLlmProviders: _ignoredCustomLlmProviders,
      llmCustomModels: _ignoredLlmCustomModels,
      pluginDevAgentMaxTurns: _ignoredPluginDevAgentMaxTurns,
      pluginDevAgentMaxContextTokens: _ignoredPluginDevAgentMaxContextTokens,
      ...safePatch
    } = rawPatch
    if (
      safePatch.defaultScraper !== undefined &&
      !isScraperPluginRunnable('video', safePatch.defaultScraper)
    ) {
      throw new Error(`影片刮削插件「${safePatch.defaultScraper}」不可用`)
    }
    if (
      safePatch.defaultActressScraper !== undefined &&
      !isScraperPluginRunnable('actress', safePatch.defaultActressScraper)
    ) {
      throw new Error(`演员刮削插件「${safePatch.defaultActressScraper}」不可用`)
    }
    const previousCloseToTray = getSettings().closeToTray
    if (safePatch.closeToTray !== undefined) setCloseToTrayEnabled(safePatch.closeToTray)
    try {
      return toSettingsSnapshot(updateSettings(safePatch))
    } catch (error) {
      if (safePatch.closeToTray !== undefined) setCloseToTrayEnabled(previousCloseToTray)
      throw error
    }
  })

  appCommandAdapter.register(IPC.SETTINGS_PICK_FOLDER, async (): Promise<string[]> => {
    const win = ctx.getWindow()
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  appCommandAdapter.register(
    IPC.SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW,
    (libraryId, rootId) => previewLibraryPathRemoval({ libraryId, rootId })
  )

  appCommandAdapter.register(
    IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM,
    (libraryId, rootId, expectedRevision, expectedImpactRevision) =>
      confirmLibraryPathRemoval({
        libraryId,
        rootId,
        expectedRevision,
        expectedImpactRevision
      })
  )

  appCommandAdapter.register(IPC.SETTINGS_MODEL_MANAGEMENT_GET, () => modelManagement.read())

  appCommandAdapter.register(IPC.SETTINGS_MODEL_MANAGEMENT_APPLY, (input) => {
    try {
      return { ok: true as const, snapshot: modelManagement.apply(input) }
    } catch (error) {
      if (!(error instanceof ModelManagementError)) throw error
      return {
        ok: false as const,
        error: {
          code: error.code,
          message: error.message,
          ...(error.usages ? { usages: error.usages } : {})
        }
      }
    }
  })

  appCommandAdapter.register(
    IPC.SETTINGS_MODEL_MANAGEMENT_DISCOVER_MODELS,
    (connectionId) => modelManagement.discoverModels(
      connectionId,
      AbortSignal.timeout(30_000)
    )
  )

  appCommandAdapter.register(
    IPC.SETTINGS_MODEL_MANAGEMENT_TEST_MODEL,
    (modelRef) => modelManagement.testModel(modelRef, AbortSignal.timeout(30_000))
  )

  appCommandAdapter.register(IPC.SETTINGS_RECOVERY_REVEAL_BACKUP, (): boolean => {
    const backupPath = getSettingsRecoveryBackupPath()
    if (!backupPath || !fs.existsSync(backupPath)) return false
    shell.showItemInFolder(backupPath)
    return true
  })

  appCommandAdapter.register(
    IPC.SETTINGS_PROXY_TEST,
    async (kind, proxyUrl): Promise<string> => {
      if (kind !== 'scrape' && kind !== 'llm') throw new Error('无效的代理类型')
      if (typeof proxyUrl !== 'string') throw new Error('请填写代理地址')
      return testProxyConnection(kind, proxyUrl)
    }
  )

  appCommandAdapter.register(IPC.LLM_TRANSLATE_TO_CHINESE, async (text): Promise<string> => {
    if (typeof text !== 'string') throw new Error('无效的翻译内容')
    return translateTextToChinese(text)
  })

  appCommandAdapter.register(IPC.ASSET_CRYPTO_SET, async (enabled): Promise<SettingsSnapshot> => {
    return mediaAssetStore.runExclusiveRelocation(async () => {
      const latest = getSettings()
      if (latest.assetEncryption === enabled) return toSettingsSnapshot(latest)
      const win = ctx.getWindow()
      await migrateAssetStorage(enabled, (p: AssetCryptoProgress) => {
        appEventAdapter.send(win?.webContents, IPC.ASSET_CRYPTO_PROGRESS, p)
      })
      return toSettingsSnapshot(updateSettings({ assetEncryption: enabled }))
    })
  })

  appCommandAdapter.register(
    IPC.ASSET_STORAGE_RELOCATE,
    async (targetPath): Promise<SettingsSnapshot> => {
      const current = getSettings()
      let newRoot: string

      if (targetPath === null) {
        newRoot = defaultMediaAssetsRoot()
      } else if (typeof targetPath === 'string' && targetPath.trim()) {
        newRoot = validateMediaAssetsPath(targetPath)
      } else {
        const win = ctx.getWindow()
        const res = await dialog.showOpenDialog(win!, {
          properties: ['openDirectory', 'createDirectory']
        })
        if (res.canceled || !res.filePaths[0]) {
          return toSettingsSnapshot(current)
        }
        newRoot = validateMediaAssetsPath(res.filePaths[0])
      }

      return mediaAssetStore.runExclusiveRelocation(async () => {
        const latest = getSettings()
        const oldRoot = resolveMediaAssetsRoot()
        if (path.resolve(oldRoot) === path.resolve(newRoot)) {
          return toSettingsSnapshot(latest)
        }
        const win = ctx.getWindow()
        const migration = await prepareMediaAssetsLocationMigration(
          oldRoot,
          newRoot,
          (p: AssetCryptoProgress) => {
            appEventAdapter.send(win?.webContents, IPC.ASSET_CRYPTO_PROGRESS, p)
          }
        )
        let updated: AppSettings
        try {
          updated = updateSettings({ mediaAssetsPath: migration.storedPath })
        } catch (error) {
          migration.rollback()
          throw error
        }
        try {
          migration.commit()
        } catch (error) {
          try {
            updateSettings({ mediaAssetsPath: latest.mediaAssetsPath })
          } catch (settingsRollbackError) {
            throw new Error(
              `${(error as Error).message}；恢复原媒体目录设置失败：${(settingsRollbackError as Error).message}`
            )
          }
          migration.rollback()
          throw error
        }
        return toSettingsSnapshot(updated)
      })
    }
  )
}
