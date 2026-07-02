import { dialog } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { AppSettings, AssetCryptoProgress, LibraryOverviewStats } from '@shared/types'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { getLibraryOverviewStats } from '../db/overviewRepo'
import { migrateAssetStorage } from '../services/assetMigration'
import { migrateMediaAssetsLocation } from '../services/assetLocationMigration'
import {
  defaultMediaAssetsRoot,
  resolveMediaAssetsRoot,
  validateMediaAssetsPath
} from '../services/assetStoragePaths'
import { testLlmModelConnection } from '../services/llmConnectionTest'
import { translateTextToChinese } from '../services/llmTextTranslate'
import { registerHandler, type IpcContext } from './shared'

function withResolvedMediaAssetsPath(settings: AppSettings): AppSettings {
  return {
    ...settings,
    mediaAssetsResolvedPath: resolveMediaAssetsRoot()
  }
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  registerHandler(IPC.SETTINGS_GET, (): AppSettings => withResolvedMediaAssetsPath(getSettings()))

  registerHandler(IPC.SETTINGS_OVERVIEW_STATS, (): LibraryOverviewStats => getLibraryOverviewStats())

  registerHandler(IPC.SETTINGS_UPDATE, (_e, patch: Partial<AppSettings>): AppSettings => {
    const { assetEncryption: _ignoredCrypto, mediaAssetsPath: _ignoredPath, ...safePatch } = patch
    return withResolvedMediaAssetsPath(updateSettings(safePatch))
  })

  registerHandler(IPC.SETTINGS_PICK_FOLDER, async (): Promise<string[]> => {
    const win = ctx.getWindow()
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  registerHandler(
    IPC.SETTINGS_LLM_TEST_MODEL,
    async (_e, providerId: string, modelId: string): Promise<void> => {
      await testLlmModelConnection(providerId, modelId)
    }
  )

  registerHandler(IPC.LLM_TRANSLATE_TO_CHINESE, async (_e, text: string): Promise<string> => {
    if (typeof text !== 'string') throw new Error('无效的翻译内容')
    return translateTextToChinese(text)
  })

  registerHandler(IPC.ASSET_CRYPTO_SET, async (_e, enabled: boolean): Promise<AppSettings> => {
    const current = getSettings()
    if (current.assetEncryption === enabled) return withResolvedMediaAssetsPath(current)

    const win = ctx.getWindow()
    await migrateAssetStorage(enabled, (p: AssetCryptoProgress) => {
      win?.webContents.send(IPC.ASSET_CRYPTO_PROGRESS, p)
    })
    return withResolvedMediaAssetsPath(updateSettings({ assetEncryption: enabled }))
  })

  registerHandler(
    IPC.ASSET_STORAGE_RELOCATE,
    async (_e, targetPath?: string | null): Promise<AppSettings> => {
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
        win?.webContents.send(IPC.ASSET_CRYPTO_PROGRESS, p)
      })
      return withResolvedMediaAssetsPath(updateSettings({ mediaAssetsPath: storedPath }))
    }
  )
}
