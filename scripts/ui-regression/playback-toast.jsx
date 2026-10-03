import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.fixtureViewports = []
window.fixtureControls = []
window.fixturePlaybackPointerDowns = 0
const snapshot = {
  sessionId: 'toast-fixture', target: { libraryId: 1, videoId: 2, resourceId: 3 }, title: 'Synthetic playback',
  source: 'local', presentation: 'expanded', presentationRevision: 1, phase: 'playing', paused: false, seeking: false,
  position: 1, duration: 120, seekable: true, volume: 50, muted: false, speed: 1, subtitleDelay: 0, subtitleSize: 55,
  tracks: [], chapters: [], error: null, resumePosition: null, recordingProgress: false, progressError: null,
  info: { videoCodec: 'fixture', audioCodec: null, width: 640, height: 360, hardwareDecoder: null, audioOutput: null, droppedFrames: null }
}
window.api = {
  playback: {
    snapshot: async () => snapshot,
    onChanged: () => () => {},
    viewport: async value => { window.fixtureViewports.push(value) },
    control: async (_id, command) => { window.fixtureControls.push(command) },
    subtitle: async () => { throw new Error('不支持此外挂字幕格式。请选择 SRT 或 ASS 字幕。') }
  },
  videos: { get: async () => ({ activeLibraryId: 1, resources: [{ id: 3, library_id: 1, video_id: 2, kind: 'local', display_name: 'Fixture' }] }) }
}
// Initialize the preload-shaped fixture API before production api.ts is imported.
const [{ default: PlaybackPanel }, { ToastProvider }, { OverlayHistoryProvider }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/playback/PlaybackPanel'),
  import('../../apps/desktop/src/renderer/src/components/Toast'),
  import('../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext')
])
document.addEventListener('pointerdown', event => {
  if (event.target.closest('[data-playback-session]')) window.fixturePlaybackPointerDowns++
})
createRoot(document.getElementById('root')).render(<ToastProvider><OverlayHistoryProvider>
  <button id="fixture-background">Background control</button>
  <PlaybackPanel />
</OverlayHistoryProvider></ToastProvider>)
