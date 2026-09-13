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
import { migrateAssetStorage } from '../services/assetMigration'
import { prepareMediaAssetsLocationMigration } from '../services/assetLocationMigration'
import { mediaAssetStore } from '@library/mediaAssetStore'
import {
  defaultMediaAssetsRoot,
  resolveMediaAssetsRoot,
  validateMediaAssetsPath
} from '@library/assetStoragePaths'
import { testProxyConnection } from '../services/proxyConnectionTest'
import { translateTextToChinese } from '../services/llmTextTranslate'
import {
  confirmLibraryPathRemoval,
  previewLibraryPathRemoval
} from '@library/scan/libraryPathCleanupService'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import { getLlmSecretStorageState } from '../settings/llmSecretStore'
import { isScraperPluginRunnable } from '../scrapers/scraperPluginService'
import { ModelManagementError, modelManagement } from '../agent-platform/modelManagement'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import { structuredError } from '@shared/protocol/errors'
import type { WebAccessStatus, WebDevice } from '@shared/webTypes'

function mapRemoteBrowserStatus(value: unknown): WebAccessStatus {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const devices = Array.isArray(row.devices) ? (row.devices as WebDevice[]) : []
  const pairingActivity = Array.isArray(row.pairingActivity)
    ? (row.pairingActivity as WebAccessStatus['pairingActivity'])
    : []
  const urls = Array.isArray(row.urls)
    ? row.urls.filter((item): item is string => typeof item === 'string')
    : []
  return {
    enabled: row.enabled === true,
    running: row.running === true || row.enabled === true,
    port: typeof row.port === 'number' ? row.port : 0,
    username: typeof row.username === 'string' ? row.username : '',
    hasPassword: row.hasPassword === true,
    urls,
    devices,
    pairingUntil: typeof row.pairingUntil === 'number' ? row.pairingUntil : 0,
    pairingActivity,
    sessions: typeof row.sessions === 'number' ? row.sessions : 0,
    error: typeof row.error === 'string' ? row.error : null
  }
}

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

export function registerSettingsHandlers(ctx: IpcContext, backend: CatalogBackend): void {
  const requireLocalCatalog = (label: string): void => {
    if (backend.mode === 'remote') {
      throw structuredError('UNSUPPORTED_CAPABILITY', `远程模式不能${label}`)
    }
  }

  appCommandAdapter.register(IPC.WEB_ACCESS_PAIR_OPEN, async () => {
    if (backend.mode === 'remote') {
      return mapRemoteBrowserStatus(await backend.browser.pairOpen({}, ipcMutation()))
    }
    return webAccess.openPairing()
  })
  appCommandAdapter.register(IPC.WEB_ACCESS_PAIR_INSPECT, async (code) => {
    if (backend.mode === 'remote') {
      return backend.browser.pairInspect({ code })
    }
    return webAccess.inspectPair(code)
  })
  appCommandAdapter.register(IPC.WEB_ACCESS_PAIR_DECIDE, async (code, approve) => {
    if (backend.mode === 'remote') {
      return mapRemoteBrowserStatus(
        await backend.browser.pairDecide(
          { code, decision: approve ? 'approve' : 'deny' },
          ipcMutation()
        )
      )
    }
    return webAccess.decidePair(code, approve)
  })
  appCommandAdapter.register(IPC.WEB_ACCESS_DEVICE_REMOVE, async (id) => {
    if (backend.mode === 'remote') {
      return mapRemoteBrowserStatus(await backend.browser.deviceRemove({ deviceId: id }, ipcMutation()))
    }
    return webAccess.removeDevice(id)
  })
  appCommandAdapter.register(IPC.WEB_ACCESS_DEVICE_RENAME, async (id, name) => {
    if (backend.mode === 'remote') {
      return mapRemoteBrowserStatus(
        await backend.browser.deviceRename({ deviceId: id, name }, ipcMutation())
      )
    }
    return webAccess.renameDevice(id, name)
  })
  appCommandAdapter.register(IPC.WEB_ACCESS_DEVICE_RESET, async () => {
    if (backend.mode === 'remote') {
      return mapRemoteBrowserStatus(await backend.browser.revokeSessions({}, ipcMutation()))
    }
    return webAccess.resetDevices()
  })
  appCommandAdapter.register(IPC.WEB_ACCESS_STATUS, async () => {
    if (backend.mode === 'remote') {
      return mapRemoteBrowserStatus(await backend.browser.status({}))
    }
    return webAccess.status()
  })
  appCommandAdapter.register(IPC.WEB_ACCESS_APPLY, async (input) => {
    if (backend.mode === 'remote') {
      return mapRemoteBrowserStatus(
        await backend.browser.setEnabled({ enabled: input.enabled }, ipcMutation())
      )
    }
    requireLocalCatalog('在本机启动网页服务')
    return webAccess.apply(input)
  })
  appCommandAdapter.register(IPC.WEB_ACCESS_REVOKE, async () => {
    if (backend.mode === 'remote') {
      return mapRemoteBrowserStatus(await backend.browser.revokeSessions({}, ipcMutation()))
    }
    return webAccess.revoke()
  })
  appCommandAdapter.register(IPC.SETTINGS_GET, (): SettingsSnapshot => toSettingsSnapshot(getSettings()))

  appCommandAdapter.register(IPC.SETTINGS_OVERVIEW_STATS, (): Promise<LibraryOverviewStats> =>
    backend.queries.overviewStats({})
  )

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
    (libraryId, rootId) => {
      requireLocalCatalog('预览本机目录清理')
      return previewLibraryPathRemoval({ libraryId, rootId })
    }
  )

  appCommandAdapter.register(
    IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM,
    (libraryId, rootId, expectedRevision, expectedImpactRevision) => {
      requireLocalCatalog('确认本机目录清理')
      return confirmLibraryPathRemoval({
        libraryId,
        rootId,
        expectedRevision,
        expectedImpactRevision
      })
    }
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
    requireLocalCatalog('开关本机图片加密')
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
      requireLocalCatalog('迁移本机图片目录')
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
