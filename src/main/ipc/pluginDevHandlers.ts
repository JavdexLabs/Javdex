import { dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  PluginDevAgentMessageInput,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevDryRunInput,
  PluginDevDryRunResult,
  PluginDevInstallInput,
  PluginDevVerifyInput,
  ScraperPluginDescriptor
} from '@shared/types'
import type { PluginDevVerificationReport } from '@shared/types'
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
import { registerHandler, type IpcContext } from './shared'

export function registerPluginDevHandlers(ctx: IpcContext): void {
  registerHandler(
    IPC.PLUGIN_DEV_AGENT_START,
    (_e, input: PluginDevAgentStartInput): Promise<PluginDevAgentSessionResult> =>
      startPluginDevAgent(
        {
          ...input,
          maxSteps: getSettings().pluginDevAgentMaxSteps,
          maxContextTokens: getSettings().pluginDevAgentMaxContextTokens
        },
        (event) => {
          ctx.getWindow()?.webContents.send(IPC.PLUGIN_DEV_AGENT_EVENT, event)
        }
      )
  )

  registerHandler(
    IPC.PLUGIN_DEV_AGENT_MESSAGE,
    (_e, input: PluginDevAgentMessageInput): Promise<PluginDevAgentSessionResult> =>
      continuePluginDevAgent(input, (event) => {
        ctx.getWindow()?.webContents.send(IPC.PLUGIN_DEV_AGENT_EVENT, event)
      })
  )

  registerHandler(IPC.PLUGIN_DEV_AGENT_CANCEL, (_e, sessionId: string): void => {
    cancelPluginDevAgent(sessionId)
  })

  registerHandler(
    IPC.PLUGIN_DEV_AGENT_EXPORT_WORK_LOG,
    async (_e, sessionId: string): Promise<string | null> => {
      const session = getSession(sessionId)
      if (!session) throw new Error('会话不存在或已过期，无法导出工作日志')
      const options = {
        title: '导出 Agent 工作日志',
        defaultPath: workLogDefaultFileName(session),
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      } as const
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

  registerHandler(
    IPC.PLUGIN_DEV_DRY_RUN,
    (_e, input: PluginDevDryRunInput): Promise<PluginDevDryRunResult> => dryRunPluginPackage(input)
  )

  registerHandler(
    IPC.PLUGIN_DEV_VERIFY,
    (_e, input: PluginDevVerifyInput): Promise<PluginDevVerificationReport> =>
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

  registerHandler(
    IPC.PLUGIN_DEV_INSTALL,
    (_e, input: PluginDevInstallInput): Promise<ScraperPluginDescriptor> =>
      installDevPluginPackage(input)
  )
}
