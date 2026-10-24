import { app, dialog, shell } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import path from 'node:path'
import { createStartupGraphicsRecovery, type StartupGpuExit } from './startupGraphicsRecovery'

const logFile = (): string => path.join(app.getPath('userData'), 'logs', 'startup.log')
export const startupGraphics = createStartupGraphicsRecovery({
  disableHardwareAcceleration: () => app.disableHardwareAcceleration(),
  relaunch: args => {
    // AppImage's temporary mount can disappear when this process exits.
    // Restart its original launcher so display/sandbox/runtime setup runs again.
    const image = process.platform === 'linux' && app.isPackaged ? process.env.APPIMAGE : undefined
    if (image && (!path.isAbsolute(image) || !statSync(image).isFile())) throw new Error('AppImage launcher unavailable')
    app.relaunch({ args, ...(image ? { execPath: image } : {}) })
  },
  quit: () => app.quit(),
  record: value => {
    const filename = logFile()
    mkdirSync(path.dirname(filename), { recursive: true })
    try { if (statSync(filename).size > 256 * 1024) renameSync(filename, filename + '.previous') } catch { /* First run or unavailable rotation. */ }
    appendFileSync(filename, JSON.stringify({ time: new Date().toISOString(), platform: process.platform, pid: process.pid, ...value }) + '\n')
  },
  failed: code => dialog.showErrorBox('Javdex 启动失败',
    (code === 'SOFTWARE_STARTUP_FAILED' ? '图形兼容模式仍无法启动，已停止自动重试。'
      : code === 'RELAUNCH_FAILED' ? '无法重新启动图形兼容模式。' : '应用初始化失败，未触发图形模式切换。')
    + '\n诊断代码：' + code + '\n启动日志：' + logFile()),
  recovered: retryGpu => {
    void dialog.showMessageBox({ type: 'info', title: '已启用图形兼容模式',
      message: '检测到图形启动故障，已使用软件模式恢复。',
      detail: '本次运行的界面与视频使用软件模式。可以继续使用，或在重启后重新尝试 GPU。',
      buttons: ['继续使用', '重新尝试 GPU', '查看启动日志'], defaultId: 0, cancelId: 0, noLink: true
    }).then(async ({ response }) => {
      if (response === 1) retryGpu()
      if (response === 2) await shell.openPath(logFile())
    }).catch(() => { /* A diagnostic dialog cannot fail a recovered application. */ })
  }
}, process.argv)

/** Installed before appMain's imports, native dependencies, or app.ready. */
export function configureStartupGraphics(): void {
  startupGraphics.configure()
  const gone = (_event: unknown, details: StartupGpuExit): void => startupGraphics.gpuExited(details)
  app.on('child-process-gone', gone)
  app.once('before-quit', () => { startupGraphics.stop(); app.removeListener('child-process-gone', gone) })
}
