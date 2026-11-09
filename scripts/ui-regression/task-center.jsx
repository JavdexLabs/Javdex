import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../../apps/desktop/src/renderer/src/styles/global.css'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import layout from '../../apps/desktop/src/renderer/src/components/Layout.module.css'
import { NavIcon } from '../../apps/desktop/src/renderer/src/components/NavIcons'
import { SidebarNavLink, SidebarNavRow, SidebarNavIcon, SidebarNavLabel } from '../../apps/desktop/src/renderer/src/components/SidebarNav'

window.React = React
window.taskCommands = []
window.failTasks = false
let scanActive = true
let onBatch = () => {}
const libraries = [{ id: 1, name: '默认媒体库', pendingScanGroupCount: 2 }]
let batch = { status: 'running', total: 200, current: 80, success: 78, pending: 2, failed: 0, currentCode: 'DEMO-081', logs: [{ time: '10:30', code: 'DEMO-080', level: 'success', message: '已写入资料' }] }
let tasks = [
  { id: 'running', title: 'DEMO-001 · 山间旅程', status: 'running', duration: 100, recognizedSeconds: 65, translatedSeconds: 42 },
  { id: 'queued', title: 'DEMO-002 · 海岸漫步', status: 'queued', duration: 100, recognizedSeconds: 0, translatedSeconds: 0 },
  { id: 'save', title: 'DEMO-003 · 森林清晨', status: 'awaiting-save', duration: 100, recognizedSeconds: 100, translatedSeconds: 100, error: '同名文件已存在' }
].map(task => ({ ...task, target: { libraryId: 1, videoId: 2, resourceId: 3 }, audioIndex: 0, output: 'bilingual', outputName: null }))
const subtitleScene = new URLSearchParams(location.search).get('scene') === 'subtitles'
if (subtitleScene) tasks = [
  { id: 'running', title: 'DEMO-001 · 山间旅程', status: 'running', duration: 7200, recognizedSeconds: 3600, translatedSeconds: 3024 },
  { id: 'failed', title: '影片播放', status: 'failed', duration: 11594, recognizedSeconds: 10124, translatedSeconds: 10124, outputName: 'DEMO-059.zh-ja.ai.ass', error: '所选影片资源不存在或不属于当前媒体库，请刷新资料后重试。原有生成进度已保留，可在恢复资源后继续处理。' },
  { id: 'paused', title: '影片播放', status: 'paused', duration: 6646, recognizedSeconds: 1200, translatedSeconds: 1200, outputName: 'DEMO-004.zh-ja.ai.ass' },
  { id: 'completed', title: '影片播放', status: 'completed', duration: 10563, recognizedSeconds: 10563, translatedSeconds: 10563, outputName: 'DEMO-071.zh-ja.ai.ass' },
  { id: 'queued', title: 'DEMO-002 · 海岸漫步', status: 'queued', duration: 5400, recognizedSeconds: 0, translatedSeconds: 0 },
  { id: 'save', title: 'DEMO-003 · 森林清晨', status: 'awaiting-save', duration: 6030, recognizedSeconds: 6030, translatedSeconds: 6030, error: '同名字幕已存在，请另存或在保存对话框中确认替换。' }
].map(task => ({ ...task, target: { libraryId: 1, videoId: 2, resourceId: 3 }, audioIndex: 1, output: 'bilingual' }))
window.taskCommandDetails = []
window.failCommand = null
window.emptyTasks = () => { tasks = []; scanActive = false; batch = { ...batch, status: 'idle' }; onBatch(batch) }
window.setBatchWithoutEvent = status => { batch = { ...batch, status } }
window.api = {
  mediaLibraries: { list: async () => libraries },
  scrape: { countPending: async () => 2, onVideoBatchProgress: fn => { onBatch = fn; return () => { onBatch = () => {} } }, pagePending: async () => ({ items: [], total: 2, offset: 0 }) },
  actressScrape: { conflictSummary: async () => ({ groupCount: 1 }), onBatchProgress: () => () => {}, pageConflicts: async () => ({ items: [], total: 1, offset: 0 }) },
  batchScrape: { getState: async () => ({ kind: 'video', progress: batch, recoverable: true }),
    ...Object.fromEntries(['pause', 'resume', 'discard'].map(action => [action, async () => {
      window.taskCommands.push(action); batch = { ...batch, status: { pause: 'paused', resume: 'running', discard: 'cancelled' }[action] }; onBatch(batch)
    }])) },
  scan: { getActive: async () => scanActive ? [{ libraryId: 1, runId: 'scan', progress: { scanned: 128, imported: 20, currentFile: 'DEMO-004.mp4' } }] : [],
    cancel: async () => { window.taskCommands.push('scan-cancel'); scanActive = false; return true },
    getAuditHeader: async () => ({ summary: null, snapshot: null, unrecognizedCount: 0 }),
    pagePendingQueue: async () => ({ items: [], total: 2, offset: 0 }), countPendingQueue: async () => 2 },
  playback: { subtitleTasks: async () => { if (window.failTasks) throw new Error('模拟字幕任务读取失败'); return { tasks, error: null } },
    subtitleTaskCommand: async command => {
      window.taskCommands.push(command.action)
      window.taskCommandDetails.push(command)
      if (window.failCommand === command.action) throw new Error('当前影片资源暂不可用，请检查文件路径后继续。')
      if (command.action === 'retry-save') tasks = tasks.map(task => task.id === command.id ? { ...task, status: 'completed', outputName: 'DEMO-003.zh-ja.ai.ass', error: null } : task)
      if (['pause', 'resume', 'cancel'].includes(command.action)) tasks = tasks.map(task => task.id === command.id ? { ...task, status: { pause: 'paused', resume: 'running', cancel: 'cancelled' }[command.action] } : task)
      if (command.action === 'remove') tasks = tasks.filter(task => task.id !== command.id)
      return { tasks, error: null }
    } }
}
applyTheme(new URLSearchParams(location.search).get('theme') || 'slate')
const { default: TaskCenterPage } = await import('../../apps/desktop/src/renderer/src/tasks/TaskCenterPage')
const { default: PendingCenterShell } = await import('../../apps/desktop/src/renderer/src/components/PendingCenterShell')
const { BatchScrapeProvider } = await import('../../apps/desktop/src/renderer/src/contexts/BatchScrapeContext')
const { useTaskCenterData } = await import('../../apps/desktop/src/renderer/src/tasks/useTaskCenterData')
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
function Sidebar() {
  const data = useTaskCenterData()
  const rows = [['home', '首页'], ['film', '默认媒体库'], ['folder', '下载'], ['cloud', '未归档'], ['playlist', '清单'], ['actress', '演员'], ['director', '导演'], ['maker', '制作商'], ['publisher', '发行商'], ['series', '系列']]
  return <aside className={layout.sidebar}>
    <div style={{ fontSize: 28, fontWeight: 700, padding: '16px 12px 28px' }}>JAV<span style={{ color: 'var(--text-accent)' }}>DEX</span></div>
    <nav className={layout.nav}><div className={layout.browseNav}>{rows.map(([icon, label]) => <SidebarNavRow key={icon}><SidebarNavLink to={`/fixture/${icon}`}><SidebarNavIcon><NavIcon name={icon} /></SidebarNavIcon><SidebarNavLabel>{label}</SidebarNavLabel></SidebarNavLink></SidebarNavRow>)}</div>
      <SidebarNavRow><SidebarNavLink active to="/tasks"><SidebarNavIcon><NavIcon name="tasks" /></SidebarNavIcon><SidebarNavLabel>任务中心</SidebarNavLabel><span data-task-count>{data.attention}</span></SidebarNavLink></SidebarNavRow>
      <SidebarNavRow><SidebarNavLink to="/settings"><SidebarNavIcon><NavIcon name="settings" /></SidebarNavIcon><SidebarNavLabel>设置</SidebarNavLabel></SidebarNavLink></SidebarNavRow>
    </nav>
  </aside>
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[subtitleScene ? '/tasks?tab=subtitles' : '/tasks']}><BatchScrapeProvider>
  <div className={layout.shell}><div className={layout.root}><Sidebar /><main className={layout.main}><Routes>
    <Route path="/tasks" element={<TaskCenterPage />} /><Route path="/pending/*" element={<PendingCenterShell />} />
    <Route path="/settings/*" element={<Link to="/tasks">返回任务中心</Link>} />
  </Routes></main></div></div>
</BatchScrapeProvider></MemoryRouter></QueryClientProvider>)
