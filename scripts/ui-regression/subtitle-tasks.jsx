import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../apps/desktop/src/renderer/src/styles/global.css'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import layout from '../../apps/desktop/src/renderer/src/components/Layout.module.css'

window.React = React
window.subtitleCommands = []
window.preparations = 0
window.associations = []
window.cancelAssociation = false
window.modelUnavailable = false
const resource = { kind: 'local', library_id: 1, video_id: 2, id: 3, is_primary: true, display_locator: 'D:/Media/ABC-123.mp4', display_name: 'ABC-123.mp4' }
let tasks = []
let files = [
  { path: 'D:/Media/ABC-123.zh.srt', name: 'ABC-123.zh.srt', source: 'directory', available: true, error: null },
  { path: 'D:/Subtitles/手动收集/ABC-123.ja.ass', name: 'ABC-123.ja.ass', source: 'linked', available: true, error: null },
  { path: 'D:/Subtitles/旧目录/ABC-123.en.srt', name: 'ABC-123.en.srt', source: 'linked', available: false, error: '文件不存在或无法读取' }
]
window.api = { playback: {
  subtitleTasks: async () => ({ tasks, error: null }),
  subtitleFiles: async () => ({ files, error: null }),
  associateSubtitleFiles: async target => {
    window.associations.push(target)
    if (window.cancelAssociation) return null
    const added = { path: 'D:/Subtitles/自选字幕/较长的文件夹名称用于检查路径换行/ABC-123.zh-Hans.ass', name: 'ABC-123.zh-Hans.ass', source: 'linked', available: true, error: null }
    if (!files.some(file => file.path === added.path)) files = [...files, added]
    return { files, error: null }
  },
  prepareSubtitles: async () => {
    window.preparations++
    if (window.modelUnavailable) throw new Error('AI 模型尚未准备，请先安装模型')
    return { duration: 90, audio: [{ index: 1, label: '日语音轨' }, { index: 2, label: '第二音轨' }], subtitles: ['ABC-123.zh.srt'], error: null }
  },
  subtitleTaskCommand: async command => {
    window.subtitleCommands.push(command)
    if (command.action === 'enqueue') tasks = [{ ...command, id: 'fixture', title: '演示影片与较长的资源名称，用于检查窄窗口布局',
      status: 'awaiting-save', duration: 90, recognizedSeconds: 90, translatedSeconds: 90, outputName: null,
      error: '同名字幕已存在，请另存或在保存对话框中确认替换' }]
    if (command.action === 'retry-save') tasks = tasks.map(task => ({ ...task, status: 'completed', error: null, outputName: 'ABC-123.zh-ja.ai.ass' }))
    if (command.action === 'remove') tasks = []
    return { tasks, error: null }
  }
} }
applyTheme(new URLSearchParams(location.search).get('theme') || 'slate')
const { default: SubtitleTasksButton } = await import('../../apps/desktop/src/renderer/src/playback/SubtitleTasksButton')
const { VideoDetailSecondaryMeta } = await import('../../apps/desktop/src/renderer/src/components/VideoDetailMeta')
createRoot(document.getElementById('root')).render(
  <div className={layout.shell}><div className={layout.root}>
    <aside className={layout.sidebar}><nav className={layout.nav}><SubtitleTasksButton /></nav></aside>
    <main className={layout.main}><VideoDetailSecondaryMeta video={{ resources: [resource] }} onAddResource={() => {}} /></main>
  </div></div>
)
