import { dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { AppSettings, SettingsSnapshot } from '@shared/settingsTypes'
import type { AssetCryptoProgress, LibraryOverviewStats } from '@shared/libraryTypes'
import {
  getEffectiveLlmApiKey,
  getLlmSecretMigrationError,
  getPublicLlmProviderConfigs,
  getSettings,
  getSettingsRecoveryBackupPath,
  getSettingsRecoveryNotice,
  updateSettings
} from '../settings/settingsStore'
import { getLibraryOverviewStats } from '../db/overviewRepo'
import { migrateAssetStorage } from '../services/assetMigration'
import { prepareMediaAssetsLocationMigration } from '../services/assetLocationMigration'
import { mediaAssetStore } from '../services/mediaAssetStore'
import {
  defaultMediaAssetsRoot,
  resolveMediaAssetsRoot,
  validateMediaAssetsPath
} from '../services/assetStoragePaths'
import { listLlmProviderModels, testLlmModelConnection } from '../services/llmConnectionTest'
import { testProxyConnection } from '../services/proxyConnectionTest'
import { translateTextToChinese } from '../services/llmTextTranslate'
import {
  confirmLibraryPathRemoval,
  previewLibraryPathRemoval
} from '../services/libraryPathCleanupService'
import { isSameLibraryPath } from '../scanner/libraryPathUtils'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import type { LlmModelDefinition } from '@shared/llmProviders'
import { BUILT_IN_LLM_PROVIDER_BY_ID, normalizeDefaultLlmSelection } from '@shared/llmProviders'
import {
  deleteLlmApiKey,
  getLlmSecretStorageState,
  saveLlmApiKeys
} from '../settings/llmSecretStore'
import { isScraperPluginRunnable } from '../scrapers/scraperPluginService'

function toSettingsSnapshot(settings: AppSettings): SettingsSnapshot {
  return {
    ...settings,
    llmProviderConfigs: getPublicLlmProviderConfigs(settings),
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
  appCommandAdapter.register(IPC.SETTINGS_GET, (): SettingsSnapshot => toSettingsSnapshot(getSettings()))

  appCommandAdapter.register(IPC.SETTINGS_OVERVIEW_STATS, (): LibraryOverviewStats => getLibraryOverviewStats())

  appCommandAdapter.register(IPC.SETTINGS_UPDATE, (patch): SettingsSnapshot => {
    const rawPatch = patch as Partial<AppSettings>
    const {
      assetEncryption: _ignoredCrypto,
      mediaAssetsPath: _ignoredPath,
      pendingLibraryPathCleanups: _ignoredCleanupQueue,
      lastLibraryScanSummary: _ignoredScanSummary,
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
    let guardedPatch: Partial<AppSettings> = safePatch
    if (safePatch.libraryPaths !== undefined) {
      if (!Array.isArray(safePatch.libraryPaths) || safePatch.libraryPaths.some((item) => typeof item !== 'string')) {
        throw new Error('无效的媒体库路径')
      }
      const current = getSettings()
      const libraryPaths = Array.from(
        new Set(safePatch.libraryPaths.map((item) => item.trim()).filter(Boolean))
      )
      const bypassedRemoval = current.libraryPaths.some(
        (currentPath) =>
          !libraryPaths.some((nextPath) => isSameLibraryPath(currentPath, nextPath))
      )
      if (bypassedRemoval) throw new Error('请通过媒体库路径的移除按钮完成此操作')
      guardedPatch = {
        ...safePatch,
        libraryPaths,
        pendingLibraryPathCleanups: current.pendingLibraryPathCleanups.filter(
          (queuedRoot) =>
            !libraryPaths.some((libraryPath) => isSameLibraryPath(queuedRoot, libraryPath))
        )
      }
    }
    return toSettingsSnapshot(updateSettings(guardedPatch))
  })

  appCommandAdapter.register(IPC.SETTINGS_PICK_FOLDER, async (): Promise<string[]> => {
    const win = ctx.getWindow()
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  appCommandAdapter.register(IPC.SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW, (libraryPath) => {
    if (typeof libraryPath !== 'string' || !libraryPath.trim()) {
      throw new Error('无效的媒体库路径')
    }
    return previewLibraryPathRemoval(libraryPath)
  })

  appCommandAdapter.register(IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM, (libraryPath) => {
    if (typeof libraryPath !== 'string' || !libraryPath.trim()) {
      throw new Error('无效的媒体库路径')
    }
    return toSettingsSnapshot(confirmLibraryPathRemoval(libraryPath))
  })

  appCommandAdapter.register(IPC.SETTINGS_LLM_PROVIDER_CONFIG_SAVE, (input) => {
    const providerId = input.providerId.trim()
    const settings = getSettings()
    const exists = BUILT_IN_LLM_PROVIDER_BY_ID.has(providerId) ||
      settings.customLlmProviders.some((provider) => provider.id === providerId)
    if (!exists) throw new Error('未知的模型供应商')
    if (input.protocol !== 'openai-chat' && input.protocol !== 'anthropic-messages') {
      throw new Error('无效的接口协议')
    }
    const apiKey = input.apiKey?.trim() ?? ''
    if (input.apiKeyAction === 'replace' && !apiKey) throw new Error('请填写 API Key')

    const oldApiKey = getEffectiveLlmApiKey(providerId)
    try {
      if (input.apiKeyAction === 'replace') saveLlmApiKeys({ [providerId]: apiKey })
      if (input.apiKeyAction === 'clear') deleteLlmApiKey(providerId)
      const configs = { ...settings.llmProviderConfigs }
      configs[providerId] = {
        ...(input.baseUrl.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
        protocol: input.protocol
      }
      return toSettingsSnapshot(updateSettings({ llmProviderConfigs: configs }))
    } catch (error) {
      try {
        if (oldApiKey) saveLlmApiKeys({ [providerId]: oldApiKey })
        else deleteLlmApiKey(providerId)
      } catch {
        // Preserve the original settings failure; the next save can repair the secret entry.
      }
      throw error
    }
  })

  appCommandAdapter.register(IPC.SETTINGS_LLM_PROVIDER_DELETE, (rawProviderId) => {
    const providerId = rawProviderId.trim()
    const settings = getSettings()
    if (BUILT_IN_LLM_PROVIDER_BY_ID.has(providerId)) throw new Error('内置供应商不能删除')
    if (!settings.customLlmProviders.some((provider) => provider.id === providerId)) {
      throw new Error('自定义供应商不存在')
    }
    const oldApiKey = getEffectiveLlmApiKey(providerId)
    try {
      deleteLlmApiKey(providerId)
      const customLlmProviders = settings.customLlmProviders.filter(
        (provider) => provider.id !== providerId
      )
      const llmProviderConfigs = { ...settings.llmProviderConfigs }
      delete llmProviderConfigs[providerId]
      const llmCustomModels = settings.llmCustomModels.filter(
        (model) => model.providerId !== providerId
      )
      const selection = normalizeDefaultLlmSelection({
        defaultLlmProviderId:
          settings.defaultLlmProviderId === providerId ? '' : settings.defaultLlmProviderId,
        defaultLlmModelId:
          settings.defaultLlmProviderId === providerId ? '' : settings.defaultLlmModelId,
        llmProviderConfigs: getPublicLlmProviderConfigs({
          ...settings,
          llmProviderConfigs,
          customLlmProviders,
          llmCustomModels
        }),
        customLlmProviders,
        llmCustomModels
      })
      return toSettingsSnapshot(updateSettings({
        customLlmProviders,
        llmProviderConfigs,
        llmCustomModels,
        defaultLlmProviderId: selection.providerId,
        defaultLlmModelId: selection.modelId
      }))
    } catch (error) {
      if (oldApiKey) {
        try {
          saveLlmApiKeys({ [providerId]: oldApiKey })
        } catch {
          // Preserve the original deletion failure.
        }
      }
      throw error
    }
  })

  appCommandAdapter.register(IPC.SETTINGS_RECOVERY_REVEAL_BACKUP, (): boolean => {
    const backupPath = getSettingsRecoveryBackupPath()
    if (!backupPath || !fs.existsSync(backupPath)) return false
    shell.showItemInFolder(backupPath)
    return true
  })

  appCommandAdapter.register(
    IPC.SETTINGS_LLM_TEST_MODEL,
    async (providerId, modelId): Promise<string> => {
      return testLlmModelConnection(providerId, modelId)
    }
  )

  appCommandAdapter.register(
    IPC.SETTINGS_LLM_LIST_MODELS,
    async (providerId): Promise<LlmModelDefinition[]> => {
      return listLlmProviderModels(providerId)
    }
  )

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
