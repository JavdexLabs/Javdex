import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.api = { llm: { translateToChinese: async text => text } }
const { default: DirectorEditModal } = await import('../../apps/desktop/src/renderer/src/components/DirectorEditModal')
const { default: Button } = await import('../../apps/desktop/src/renderer/src/components/Button')
const { ToastProvider, useToast } = await import('../../apps/desktop/src/renderer/src/components/Toast')
window.__calls = 0
window.__error = '无法保存：/很长的中文目录/'.repeat(50) + '请检查服务端连接后重试。'
function App() {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  return <main>
    <Button onClick={() => setOpen(true)}>打开编辑</Button>
    <Button onClick={() => toast.show(window.__error, 'error')}>显示错误</Button>
    {open && <DirectorEditModal onCancel={() => setOpen(false)} onSave={async () => {
      window.__calls++
      await new Promise(resolve => { window.__release = resolve })
      if (window.__calls === 1) throw new Error(window.__error)
      setOpen(false)
    }} />}
  </main>
}
createRoot(document.getElementById('root')).render(<ToastProvider><App /></ToastProvider>)
