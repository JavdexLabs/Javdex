import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.fixtureCommands = []
window.fixtureViewports = []
const fullscreen = new URLSearchParams(location.search).has('fullscreen')
let revision = 1
const listeners = new Set()
let snapshot = {
  sessionId: 'settings-fixture', target: { libraryId: 1, videoId: 2, resourceId: 3 }, title: 'Synthetic settings',
  source: 'local', presentation: fullscreen ? 'fullscreen' : 'expanded', rendererFullscreenControls: fullscreen,
  presentationRevision: 1, phase: 'paused', paused: true, seeking: false,
  position: 1, duration: 120, seekable: true, volume: 50, muted: false, speed: 1, subtitleDelay: 0, subtitleSize: 55,
  tracks: [
    { type: 'audio', id: 1, title: 'Main', language: 'eng', codec: 'aac', channelCountHint: 2, selected: true },
    { type: 'audio', id: 2, title: 'Dub', language: 'jpn', codec: 'ac3', channelCountHint: 6, selected: false },
    { type: 'sub', id: 3, title: 'Styled', language: 'eng', codec: 'ass', selected: true },
    { type: 'sub', id: 4, title: 'Plain', language: 'eng', codec: 'subrip', selected: false },
    { type: 'sub', id: 5, title: 'Bitmap', language: 'eng', codec: 'hdmv_pgs_subtitle', selected: false }
  ],
  chapters: [{ title: 'Opening', time: 0 }, { title: 'Middle', time: 12 }, { title: 'Ending', time: 24 }],
  error: null, resumePosition: null, recordingProgress: false, progressError: null,
  info: { videoCodec: 'fixture', audioCodec: null, width: 640, height: 360, hardwareDecoder: null, audioOutput: null, droppedFrames: null }
}
window.api = {
  settings: { onLocalModelsChanged: () => () => {}, getLocalModels: async () => { throw new Error('No synthetic model store') } },
  playback: {
    snapshot: async () => snapshot,
    observation: async () => ({ snapshot, revision }),
    onChanged: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    aiSubtitleSnapshot: async () => null, onAiSubtitleChanged: () => () => {},
    viewport: async value => { window.fixtureViewports.push(value); if (window.fixtureViewports.length > 100) window.fixtureViewports.shift() },
    control: async (id, command) => {
      if (id !== snapshot.sessionId) throw new Error('Wrong fixture session')
      window.fixtureCommands.push(command)
      switch (command.kind) {
        case 'track': snapshot = { ...snapshot, tracks: snapshot.tracks.map(track => track.type === command.type
          ? { ...track, selected: track.id === command.id } : track) }; break
        case 'speed': snapshot = { ...snapshot, speed: command.value }; break
        case 'seek': snapshot = { ...snapshot, position: command.seconds }; break
        case 'pause': snapshot = { ...snapshot, paused: command.paused, phase: command.paused ? 'paused' : 'playing' }; break
        case 'volume': snapshot = { ...snapshot, volume: command.value }; break
        case 'mute': snapshot = { ...snapshot, muted: command.muted }; break
        case 'presentation': snapshot = { ...snapshot, presentation: command.value, presentationRevision: snapshot.presentationRevision + 1 }; break
        case 'stop': snapshot = null; break
        case 'subtitle-size': snapshot = { ...snapshot, subtitleSize: command.value }; break
        case 'subtitle-delay': snapshot = { ...snapshot, subtitleDelay: command.seconds }; break
        default: throw new Error(`Unexpected fixture command: ${command.kind}`)
      }
      revision++
      for (const callback of listeners) callback(snapshot, revision)
    }
  },
  videos: { get: async () => ({ activeLibraryId: 1, resources: [{ id: 3, library_id: 1, video_id: 2, kind: 'local', display_name: 'Fixture' }] }) }
}
const [{ default: PlaybackPanel }, { ToastProvider }, { OverlayHistoryProvider }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/playback/PlaybackPanel'),
  import('../../apps/desktop/src/renderer/src/components/Toast'),
  import('../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext')
])
createRoot(document.getElementById('root')).render(<MemoryRouter><ToastProvider><OverlayHistoryProvider>
  <PlaybackPanel />
</OverlayHistoryProvider></ToastProvider></MemoryRouter>)
