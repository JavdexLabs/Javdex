import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import ResetListStateOnReload from './listView/ResetListStateOnReload'
import Layout from './components/Layout'
import LibraryShell from './components/LibraryShell'
import ActressShell from './components/ActressShell'
import FacetShell from './components/FacetShell'
import DetailPage from './pages/DetailPage'
import ActressDetailPage from './pages/ActressDetailPage'
import FacetDetailPage from './pages/FacetDetailPage'
import PlaylistShell from './components/PlaylistShell'
import PlaylistDetailPage from './pages/PlaylistDetailPage'
import SettingsPage from './pages/SettingsPage'
import { PluginDevLeaveGuardProvider } from './components/pluginDev/PluginDevLeaveGuard'
import { ToastProvider } from './components/Toast'
import { DisplayModeProvider } from './components/DisplayModeContext'
import { ThemeProvider } from './components/ThemeProvider'
import { AppBackgroundProvider } from './components/AppBackgroundContext'
import { ImagePreviewOverlayProvider } from './components/ImagePreviewOverlayContext'
import { installDisableInputSpellcheck } from './installDisableInputSpellcheck'

export default function App(): JSX.Element {
  useEffect(() => installDisableInputSpellcheck(), [])

  return (
    <ThemeProvider>
      <ToastProvider>
        <DisplayModeProvider>
          <AppBackgroundProvider>
            <ImagePreviewOverlayProvider>
            <PluginDevLeaveGuardProvider>
            <Layout>
              <ResetListStateOnReload />
              <Routes>
                <Route path="/" element={<LibraryShell />}>
                  <Route index element={null} />
                  <Route path="detail/:id" element={<DetailPage />}>
                    <Route path="actress/:actressId" element={<ActressDetailPage />} />
                  </Route>
                </Route>
                <Route path="/actresses" element={<ActressShell />}>
                  <Route index element={null} />
                  <Route path=":id" element={<ActressDetailPage />}>
                    <Route path=":videoId" element={<DetailPage />}>
                      <Route path="actress/:actressId" element={<ActressDetailPage />} />
                    </Route>
                  </Route>
                </Route>
                <Route path="/playlists" element={<PlaylistShell />}>
                  <Route index element={null} />
                  <Route path=":playlistId" element={<PlaylistDetailPage />}>
                    <Route path=":id" element={<DetailPage />}>
                      <Route path="actress/:actressId" element={<ActressDetailPage />} />
                    </Route>
                  </Route>
                </Route>
                <Route path="/facet/:type" element={<FacetShell />}>
                  <Route index element={null} />
                  <Route path="v/:valueKey" element={<FacetDetailPage />}>
                    <Route path=":id" element={<DetailPage />}>
                      <Route path="actress/:actressId" element={<ActressDetailPage />} />
                    </Route>
                  </Route>
                </Route>
                <Route path="/settings/*" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
            </PluginDevLeaveGuardProvider>
            </ImagePreviewOverlayProvider>
          </AppBackgroundProvider>
        </DisplayModeProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
