import { dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { PluginDevAgentMessageInput, PluginDevAgentSessionResult, PluginDevAgentStartInput, PluginDevDryRunInput, PluginDevDryRunResult, PluginDevInstallInput, PluginDevVerifyInput } from '@shared/pluginDevTypes'
import type { ScraperPluginDescriptor } from '@shared/scrapeTypes'
import type { PluginDevVerificationReport } from '@shared/pluginDevTypes'
import { dryRunPluginPackage, installDevPluginPackage } from '../services/pluginDevService'
import {
  cancelPluginDevAgent,
  continuePluginDevAgent,
  startPluginDevAgent
} from '../services/pluginDevAgent/runner'
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
  appCommandAdapter.register(
    IPC.PLUGIN_DEV_AGENT_START,
    (input): Promise<PluginDevAgentSessionResult> =>
      startPluginDevAgent(
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
      continuePluginDevAgent(input, (event) => {
        appEventAdapter.send(ctx.getWindow()?.webContents, IPC.PLUGIN_DEV_AGENT_EVENT, event)
      })
  )

  appCommandAdapter.register(IPC.PLUGIN_DEV_AGENT_CANCEL, (sessionId): void => {
    cancelPluginDevAgent(sessionId)
  })

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
