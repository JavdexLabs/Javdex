import React from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider, useLocation, useNavigate } from 'react-router-dom'
import '../../apps/desktop/src/renderer/src/styles/global.css'

// Browser-only history fixture: real router/overlay/panel, synthetic playback
// RPC. ?resume=1 models a main-process session surviving renderer reload;
// ?delay=500 holds presentation acknowledgements without touching user media.
window.React = React
const query = new URLSearchParams(location.search)
const persistent = query.get('resume') === '1'
const storageKey = 'javdex-playback-history-fixture-v1'
let state = persistent ? JSON.parse(sessionStorage.getItem(storageKey) || 'null') : query.get('active') === '1' ? makeState() : null
const listeners = new Set()
const controls = []
const publish = value => {
  state = value
  if (persistent) sessionStorage.setItem(storageKey, JSON.stringify(value))
  for (const listener of listeners) listener(value)
}
function makeState(presentation = 'expanded') {
  return { sessionId: 'history-fixture', target: { libraryId: 1, videoId: 2, resourceId: 3 }, title: 'Synthetic playback',
    source: 'local', presentation, presentationRevision: 1, rendererFullscreenControls: true, phase: 'playing', paused: false, seeking: false,
    position: 1, duration: 120, seekable: true, volume: 50, muted: false, speed: 1, subtitleDelay: 0, subtitleSize: 55,
    tracks: [], chapters: [], error: null, resumePosition: null, recordingProgress: false, progressError: null,
    info: { videoCodec: 'fixture', audioCodec: null, width: 640, height: 360, hardwareDecoder: null, audioOutput: null, droppedFrames: null } }
}
window.api = {
  settings: { onLocalModelsChanged: () => () => {}, getLocalModels: async () => { throw new Error('Synthetic models unavailable') } },
  playback: {
    snapshot: async () => state,
    onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    aiSubtitleSnapshot: async () => null, onAiSubtitleChanged: () => () => {}, viewport: async () => {},
    control: async (_id, command) => {
      controls.push(command)
      if (query.get('delay')) await new Promise(resolve => setTimeout(resolve, Number(query.get('delay'))))
      if (command.kind === 'presentation' && state) publish({ ...state, presentation: command.value, presentationRevision: state.presentationRevision + 1 })
      if (command.kind === 'stop') publish(null)
    }
  },
  videos: { get: async () => ({ activeLibraryId: 1, resources: [{ id: 3, library_id: 1, video_id: 2, kind: 'local', display_name: 'Fixture' }] }) }
}
const [{ default: PlaybackPanel }, { ToastProvider }, { OverlayHistoryProvider }, { NavigationGuardProvider }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/playback/PlaybackPanel'),
  import('../../apps/desktop/src/renderer/src/components/Toast'),
  import('../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext'),
  import('../../apps/desktop/src/renderer/src/interaction/NavigationGuard')
])
function Fixture() {
  const route = useLocation()
  const navigate = useNavigate()
  const [current, setCurrent] = React.useState(state)
  React.useEffect(() => { listeners.add(setCurrent); return () => listeners.delete(setCurrent) }, [])
  return <ToastProvider><OverlayHistoryProvider><NavigationGuardProvider>
    <main style={{ padding: 32 }}>
      <h1>播放返回回归夹具</h1><p role="status">业务路由：{route.pathname}{route.search}</p>
      <p>播放呈现：{current?.presentation ?? 'stopped'}；已接收命令：{controls.map(command => command.kind === 'presentation' ? command.value : command.kind).join(', ') || 'none'}</p>
      <button onClick={() => navigate('/libraries/1/video/2')}>打开影片详情</button>
      <button onClick={() => publish(makeState())}>播放测试会话</button>
      <button onClick={() => navigate('/settings/models/usage')}>打开其他业务页</button>
    </main>
    <PlaybackPanel />
  </NavigationGuardProvider></OverlayHistoryProvider></ToastProvider>
}
const router = createHashRouter([{ path: '*', element: <Fixture /> }])
const root = createRoot(document.getElementById('root'))
root.render(<RouterProvider router={router} />)
// Hot updates must not leave duplicate React roots or router listeners behind.
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); router.dispose() })
