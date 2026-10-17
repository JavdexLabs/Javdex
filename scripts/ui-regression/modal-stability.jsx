import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '../../apps/desktop/src/renderer/src/components/Toast'
import { OverlayHistoryProvider } from '../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
let finishMovePreview
window.movePreviewCalls = []
window.api = {
  mediaLibraries: { list: async () => [
    { id: 1, name: '源库', status: 'active' },
    { id: 2, name: '目标库', status: 'active' }
  ] },
  videos: { previewMoveResource: (...args) => {
    window.movePreviewCalls.push(args)
    return new Promise(resolve => { finishMovePreview = resolve })
  } }
}
window.finishMovePreview = () => finishMovePreview({ revision: 1, resourceIds: [1], libraries: [] })
applyTheme(new URLSearchParams(location.search).get('theme') || 'slate')
const { default: DirectorEditModal } = await import('../../apps/desktop/src/renderer/src/components/DirectorEditModal')
const { default: VideoResourceMoveModal } = await import('../../apps/desktop/src/renderer/src/components/VideoResourceMoveModal')
const { default: Modal } = await import('../../apps/desktop/src/renderer/src/components/Modal')
const [{ EditForm, EditFormField }, { default: TextInput }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/components/FormPrimitives'),
  import('../../apps/desktop/src/renderer/src/components/TextInput')
])
let finish
window.rejectModalSave = () => finish(new Error('合成保存失败：请保留当前草稿并重新检查连接。\n'.repeat(20) + '合成错误详情末尾'))
const save = () => new Promise((_resolve, reject) => { finish = reject })
function LoadingForm() {
  const [loading, setLoading] = useState(true)
  window.finishModalLoading = () => setLoading(false)
  return <Modal title="动态表单" layout="form" size="lg" confirmText="保存" onCancel={() => {}} onConfirm={save}>
    {loading ? <p>正在读取表单…</p> : <EditForm>
      {['名称', '地址', '说明', '备注'].map((label, index) => <EditFormField key={label} label={label} htmlFor={`loaded-${index}`}>
        <TextInput id={`loaded-${index}`} defaultValue={`保留${label}`} />
      </EditFormField>)}
    </EditForm>}
  </Modal>
}
createRoot(document.getElementById('root')).render(<ToastProvider><OverlayHistoryProvider>
  {new URLSearchParams(location.search).has('move') ? <VideoResourceMoveModal sourceLibraryId={1}
    resource={{ id: 1, display_name: '合成资源', display_locator: 'https://example.invalid/video' }}
    onCancel={() => {}} onMoved={() => { throw new Error('This fixture must not submit a resource move') }} />
    : new URLSearchParams(location.search).has('loading') ? <LoadingForm /> : new URLSearchParams(location.search).has('compact') ? <Modal title="紧凑确认" confirmText="保存" onCancel={() => {}} onConfirm={save}>
    <p>确认处理合成条目？</p>
  </Modal> : <DirectorEditModal director={{ id: 1, mainName: '合成导演', aliases: [], links: [] }} onCancel={() => {}} onSave={save} />}
</OverlayHistoryProvider></ToastProvider>)
