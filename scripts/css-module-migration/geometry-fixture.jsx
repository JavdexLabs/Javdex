import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../apps/desktop/src/renderer/src/styles/global.css'
import FloatingLayer from '../../apps/desktop/src/renderer/src/components/FloatingLayer'
import VirtualGridViewport from '../../apps/desktop/src/renderer/src/components/VirtualGridViewport'

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme')
function Fixture() {
  const [open, setOpen] = useState(true)
  const anchorRef = useRef(null)
  const ignoredRef = useRef(null)
  return <main style={{ padding: 24, paddingTop: 120, minHeight: 2000 }}>
    <button ref={anchorRef} onClick={() => setOpen(true)}>打开浮层</button>
    <button ref={ignoredRef}>忽略关闭的按钮</button>
    <button data-outside>外部按钮</button>
    <FloatingLayer open={open} anchorRef={anchorRef} side="bottom" align="start" offset={8}
      role="dialog" ariaLabel="浮层几何检查" className="fixture-caller-layer"
      ignoreCloseRefs={[ignoredRef]} onClose={() => setOpen(false)}
      style={{ position: 'absolute', zIndex: 1, top: 0, left: 0, visibility: 'hidden', width: 180 }}>
      <button>浮层内部按钮</button>
    </FloatingLayer>
    <VirtualGridViewport data-geometry-viewport style={{ width: 180, height: 80, overflow: 'scroll' }}>
      <div style={{ width: 300, height: 400 }}>网格滚动内容</div>
    </VirtualGridViewport>
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
