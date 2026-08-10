import { dialog } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { AppSettings } from '@shared/settingsTypes'
import type { AssetCryptoProgress, LibraryOverviewStats } from '@shared/libraryTypes'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { getLibraryOverviewStats } from '../db/overviewRepo'
import { migrateAssetStorage } from '../services/assetMigration'
import { migrateMediaAssetsLocation } from '../services/assetLocationMigration'
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

function withResolvedMediaAssetsPath(settings: AppSettings): AppSettings {
  return {
    ...settings,
    mediaAssetsResolvedPath: resolveMediaAssetsRoot()
  }
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  appCommandAdapter.register(IPC.SETTINGS_GET, (): AppSettings => withResolvedMediaAssetsPath(getSettings()))

  appCommandAdapter.register(IPC.SETTINGS_OVERVIEW_STATS, (): LibraryOverviewStats => getLibraryOverviewStats())

  appCommandAdapter.register(IPC.SETTINGS_UPDATE, (patch): AppSettings => {
    const {
      assetEncryption: _ignoredCrypto,
      mediaAssetsPath: _ignoredPath,
      pendingLibraryPathCleanups: _ignoredCleanupQueue,
      lastLibraryScanSummary: _ignoredScanSummary,
      ...safePatch
    } = patch
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
    return withResolvedMediaAssetsPath(updateSettings(guardedPatch))
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
    return withResolvedMediaAssetsPath(confirmLibraryPathRemoval(libraryPath))
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

  appCommandAdapter.register(IPC.ASSET_CRYPTO_SET, async (enabled): Promise<AppSettings> => {
    const current = getSettings()
    if (current.assetEncryption === enabled) return withResolvedMediaAssetsPath(current)

    const win = ctx.getWindow()
    await migrateAssetStorage(enabled, (p: AssetCryptoProgress) => {
      appEventAdapter.send(win?.webContents, IPC.ASSET_CRYPTO_PROGRESS, p)
    })
    return withResolvedMediaAssetsPath(updateSettings({ assetEncryption: enabled }))
  })

  appCommandAdapter.register(
    IPC.ASSET_STORAGE_RELOCATE,
    async (targetPath): Promise<AppSettings> => {
      const current = getSettings()
      const oldRoot = resolveMediaAssetsRoot()
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
          return withResolvedMediaAssetsPath(current)
        }
        newRoot = validateMediaAssetsPath(res.filePaths[0])
      }

      if (path.resolve(oldRoot) === path.resolve(newRoot)) {
        return withResolvedMediaAssetsPath(current)
      }

      const win = ctx.getWindow()
      const storedPath = await migrateMediaAssetsLocation(oldRoot, newRoot, (p: AssetCryptoProgress) => {
        appEventAdapter.send(win?.webContents, IPC.ASSET_CRYPTO_PROGRESS, p)
      })
      return withResolvedMediaAssetsPath(updateSettings({ mediaAssetsPath: storedPath }))
    }
  )
}
