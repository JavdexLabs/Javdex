import { dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { PluginDevAgentSessionResult, PluginDevDryRunResult } from '@shared/pluginDevTypes'
import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import type { PluginDevVerificationReport } from '@shared/pluginDevTypes'
import { dryRunPluginPackage, installDevPluginPackage } from '../services/pluginDevService'
import { pluginDeveloper } from '../services/pluginDevAgent/pluginDeveloper'
import { initializeAgentPlatform } from '../agent-platform/composition'
import { getSession } from '../services/pluginDevAgent/sessionStore'
import {
  sanitizeWorkLogPath,
  workLogDefaultFileName,
  writePluginDevAgentWorkLog
} from '../services/pluginDevAgent/workLog'
import { verifyDebugResultAgainstPages } from '../services/pluginDevVerification'
import { getSettings } from '../settings/settingsStore'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'

export function registerPluginDevHandlers(ctx: IpcContext): void {
  initializeAgentPlatform()
  appCommandAdapter.register(
    IPC.PLUGIN_DEV_AGENT_START,
    (input): Promise<PluginDevAgentSessionResult> =>
      pluginDeveloper.start(
        {
          ...input,
          maxSteps: getSettings().pluginDevAgentMaxSteps,
          maxContextTokens: getSettings().pluginDevAgentMaxContextTokens
        },
        (event) => {
          appEventAdapter.send(ctx.getWindow()?.webContents, IPC.PLUGIN_DEV_AGENT_EVENT, event)
        }
      )
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
    IPC.PLUGIN_DEV_AGENT_EXPORT_WORK_LOG,
    async (sessionId): Promise<string | null> => {
      const session = getSession(sessionId)
      if (!session) throw new Error('会话不存在或已过期，无法导出工作日志')
      const options: Electron.SaveDialogOptions = {
        title: '导出 Agent 工作日志',
        defaultPath: workLogDefaultFileName(session),
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
      writePluginDevAgentWorkLog(sessionId, targetPath)
      return targetPath
    }
  )

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_DRY_RUN,
    (input): Promise<PluginDevDryRunResult> => dryRunPluginPackage(input)
  )

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_VERIFY,
    (input): Promise<PluginDevVerificationReport> =>
      verifyDebugResultAgainstPages({
        kind: input.kind,
        lastResult: input.lastResult,
        discovery: input.discovery,
        supportedFields: input.supportedFields,
        userFeedback: input.userFeedback,
        testTarget: input.testTarget,
        testTargets: input.testTargets
      })
  )

  appCommandAdapter.register(
    IPC.PLUGIN_DEV_INSTALL,
    (input): Promise<ScraperPluginDescriptor> =>
      installDevPluginPackage(input)
  )
}
