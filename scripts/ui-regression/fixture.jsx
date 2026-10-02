import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Modal from '../../apps/desktop/src/renderer/src/components/Modal'
import SelectControl from '../../apps/desktop/src/renderer/src/components/SelectControl'
import FloatingLayer from '../../apps/desktop/src/renderer/src/components/FloatingLayer'
import ImagePreviewLightbox from '../../apps/desktop/src/renderer/src/components/ImagePreviewLightbox'
import { ExportProgressModal } from '../../apps/desktop/src/renderer/src/components/settings/NfoExportPanel'
import PluginCard from '../../apps/desktop/src/renderer/src/components/PluginCard'
import ClassificationPicker from '../../apps/desktop/src/renderer/src/components/ClassificationPicker'
import { ImagePreviewOverlayProvider, useHistoryBackedImagePreviewState } from '../../apps/desktop/src/renderer/src/components/ImagePreviewOverlayContext'
import { useContinuousPage } from '../../apps/desktop/src/renderer/src/hooks/useContinuousPage'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
const syntheticImage = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>')

function Fixture() {
  const [dialog, setDialog] = useState(false)
  const [nested, setNested] = useState(false)
  const [popover, setPopover] = useState(false)
  const [foregroundTask, setForegroundTask] = useState(false)
  const [taskError, setTaskError] = useState(null)
  const [taskStarted, setTaskStarted] = useState(false)
  const taskReturnRef = React.useRef(null)
  const anchor = React.useRef(null)
  const [value, setValue] = useState('one')
  const [organization, setOrganization] = useState('')
  const [scope, setScope] = useState('first')
  const preview = useHistoryBackedImagePreviewState()
  const [index, setIndex] = useState(0)
  const continuous = useContinuousPage(scope, 10, async () => {
    if (scope === 'first') await new Promise(resolve => { window.finishOldRead = resolve })
    return { items: [{ id: scope, title: scope }], total: 1 }
  })
  return <>
    <button onClick={() => setDialog(true)}>打开弹窗</button>
    <button ref={taskReturnRef}>生成预览</button>
    {!taskStarted && <button onClick={() => { window.finishForegroundTask = () => setForegroundTask(false); setTaskStarted(true); setForegroundTask(true) }}>打开前台任务</button>}
    <button onClick={() => setScope('second')}>切换浏览会话</button>
    <output data-session>{continuous.items.map(item => item.title).join(',')}</output>
    {foregroundTask && <ExportProgressModal modal={{ taskId: 'fixture', progress: null, report: null, terminating: false, error: taskError }}
      returnFocusRef={taskReturnRef} onTerminate={async () => { window.terminationRequests++; setTaskError('合成停止失败，请重试') }} onClose={() => setForegroundTask(false)} />}
    {dialog && <Modal title="外层弹窗" onCancel={() => setDialog(false)} onConfirm={async () => {
      await new Promise(resolve => { window.finishSave = resolve })
    }}>
      <input aria-label="草稿" defaultValue="保留内容" />
      <PluginCard plugin={{ kind: 'video', name: '合成插件', version: '1.0.0', description: '合成菜单回归', source: 'user', removable: true, exportable: true, supportedFields: [] }}
        allFieldCount={1} isDefault={false} actionsDisabled={false} onEdit={() => {}} onExport={() => {}} onAiDebug={() => {}} onRequestDelete={() => {}} onSetDefault={() => {}} />
      <label htmlFor="fixture-organization">所属机构</label>
      <ClassificationPicker id="fixture-organization" value={organization} onValueChange={setOrganization}
        options={[{ id: 1, mainName: '合成机构', description: '' }]} selectedId={null} listLabel="机构候选"
        onSelect={option => setOrganization(option.mainName)} />
      <input aria-label="后续字段" />
      <SelectControl aria-label="选项" value={value} onChange={event => setValue(event.target.value)}>
        <option value="one">第一项</option><option value="two">第二项</option>
      </SelectControl>
      <button ref={anchor} onClick={() => setPopover(true)}>打开浮层</button>
      <FloatingLayer open={popover} anchorRef={anchor} side="bottom" align="start" onClose={() => setPopover(false)} role="dialog" ariaLabel="嵌套浮层">
        <SelectControl aria-label="浮层选项" value={value} onChange={event => setValue(event.target.value)}>
          <option value="one">第一项</option><option value="two">第二项</option>
        </SelectControl>
      </FloatingLayer>
      <button onClick={() => setNested(true)}>打开子弹窗</button>
      <button onClick={preview.open}>打开图片预览</button>
      {nested && <Modal title="子弹窗" onCancel={() => setNested(false)} hideActions><input aria-label="子草稿" /></Modal>}
      {preview.isOpen && <ImagePreviewLightbox items={[{ id: 1, src: syntheticImage }, { id: 2, src: syntheticImage }]}
        index={index} onIndexChange={setIndex} onClose={preview.close} labels={{ dialog: '合成图片预览', filmstrip: '缩略图', thumb: i => `第${i + 1}张` }} />}
    </Modal>}
  </>
}

document.body.style.overflow = 'auto'
window.globalShortcutCalls = 0
window.terminationRequests = 0
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') window.globalShortcutCalls++
})
createRoot(document.getElementById('root')).render(<React.StrictMode><ImagePreviewOverlayProvider><Fixture /></ImagePreviewOverlayProvider></React.StrictMode>)
