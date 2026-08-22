import { dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { PluginDevAgentSessionResult, PluginDevDryRunResult } from '@shared/pluginDevTypes'
import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import { dryRunPluginPackage, installDevPluginPackage } from '../services/pluginDevService'
import { pluginDeveloper } from '../services/pluginDevAgent/pluginDeveloper'
import { initializeAgentPlatform } from '../agent-platform/composition'
import { modelManagement } from '../agent-platform/modelManagement'
import { getSession } from '../services/pluginDevAgent/sessionStore'
import {
  sanitizeWorkLogPath,
  workLogDefaultFileName,
  writePluginDevAgentWorkLog
} from '../services/pluginDevAgent/workLog'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'

export function registerPluginDevHandlers(ctx: IpcContext): void {
  initializeAgentPlatform()
  appCommandAdapter.register(
    IPC.PLUGIN_DEV_AGENT_START,
    (input): Promise<PluginDevAgentSessionResult> => {
      const assignment = modelManagement.read().assignments.find(
        (item) => item.workloadId === 'plugin-developer'
      )
      if (!assignment) throw new Error('缺少插件开发用途配置')
      return pluginDeveloper.start(
        {
          ...input,
          maxSteps: assignment.limits.maxTurns,
          maxContextTokens: assignment.limits.maxContextTokens
        },
        (event) => {
          appEventAdapter.send(ctx.getWindow()?.webContents, IPC.PLUGIN_DEV_AGENT_EVENT, event)
        }
      )
    }
  )

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_AGENT_MESSAGE,
    (input): Promise<PluginDevAgentSessionResult> =>
      pluginDeveloper.message(input, (event) => {
        appEventAdapter.send(ctx.getWindow()?.webContents, IPC.PLUGIN_DEV_AGENT_EVENT, event)
      })
  )

  appCommandAdapter.register(IPC.PLUGIN_DEV_AGENT_CANCEL, async (sessionId): Promise<void> => {
    await pluginDeveloper.cancel(sessionId)
  })

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_AGENT_SNAPSHOT,
    (sessionId) => pluginDeveloper.getSnapshot(sessionId)
  )

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_AGENT_CLEAR_HISTORY,
    () => pluginDeveloper.clearHistory()
  )

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_AGENT_EXPORT_WORK_LOG,
    async (sessionId): Promise<string | null> => {
      const session = getSession(sessionId)
      const snapshot = session ? undefined : pluginDeveloper.getSnapshot(sessionId) ?? undefined
      if (!session && !snapshot) throw new Error('会话不存在或已过期，无法导出工作日志')
      const options: Electron.SaveDialogOptions = {
        title: '导出 Agent 工作日志',
        defaultPath: workLogDefaultFileName(
          session ?? { siteName: snapshot!.input.siteName, id: snapshot!.result.sessionId }
        ),
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const win = ctx.getWindow()
      const res = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (res.canceled || !res.filePath) return null
      const targetPath = sanitizeWorkLogPath(res.filePath)
      writePluginDevAgentWorkLog(sessionId, targetPath, snapshot)
      return targetPath
    }
  )

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_DRY_RUN,
    (input): Promise<PluginDevDryRunResult> => dryRunPluginPackage(input)
  )

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_INSTALL,
    async (input): Promise<ScraperPluginDescriptor> => {
      if (input.sessionId) pluginDeveloper.assertReadyArtifact(input.sessionId, input.package)
      const descriptor = await installDevPluginPackage(input)
      if (input.sessionId) {
        try {
          pluginDeveloper.markInstalled(input.sessionId, input.package)
        } catch (error) {
          pluginDeveloper.recordInstallationProjectionFailure(input.sessionId, error)
          console.error('[plugin-dev] plugin installed but lifecycle projection failed', error)
        }
      }
      return descriptor
    }
  )
}
