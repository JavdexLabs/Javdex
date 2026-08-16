import { useEffect } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import ResetListStateOnReload from './listView/ResetListStateOnReload'
import Layout from './components/Layout'
import LibraryShell from './components/LibraryShell'
import ActressShell from './components/ActressShell'
import FacetShell from './components/FacetShell'
import DetailPage from './pages/DetailPage'
import ActressDetailPage from './pages/ActressDetailPage'
import OrganizationDetailPage from './pages/OrganizationDetailPage'
import DirectorDetailPage from './pages/DirectorDetailPage'
import SeriesDetailPage from './pages/SeriesDetailPage'
import PlaylistShell from './components/PlaylistShell'
import PlaylistDetailPage from './pages/PlaylistDetailPage'
import SettingsPage from './pages/SettingsPage'
import PendingCenterShell from './components/PendingCenterShell'
import { PluginDevLeaveGuardProvider } from './components/pluginDev/PluginDevLeaveGuard'
import { ToastProvider } from './components/Toast'
import { DisplayModeProvider } from './components/DisplayModeContext'
import { ThemeProvider, useTheme } from './components/ThemeProvider'
import { AppBackgroundProvider } from './components/AppBackgroundContext'
import { ImagePreviewOverlayProvider } from './components/ImagePreviewOverlayContext'
import { AvatarAutoCropBatchProvider } from './contexts/AvatarAutoCropBatchContext'
import { installDisableInputSpellcheck } from './installDisableInputSpellcheck'
import { ROUTE_PATH, ROUTE_SEGMENT } from './listView/routePaths'
import { facetListPath } from './listView/facetRoutes'
import { isFacetType, supportsFacetDetail, type FacetDetailKind } from './facet'
import { pendingCenterPath } from './listView/pendingRoutes'
import { SETTINGS_GROUPS, settingsPath } from './settings/settingsRoutes'
import {
  SettingsPluginDevOutlet,
  SettingsSectionOutlet
} from './settings/SettingsRouteOutlet'

function FacetDetailRoute({
  kind,
  children
}: {
  kind: FacetDetailKind
  children: JSX.Element
}): JSX.Element {
  const { type } = useParams()
  if (supportsFacetDetail(type, kind)) return children
  return <Navigate to={isFacetType(type) ? facetListPath(type) : ROUTE_PATH.library} replace />
}

function AppContent(): JSX.Element {
  const { privacyMode } = useTheme()
  const imagePreviewEnabled = !(
    privacyMode.privacyModeEnabled &&
    privacyMode.privacyModeScopes.includes('imagePreview')
  )
  return (
    <ToastProvider>
      <AvatarAutoCropBatchProvider>
        <DisplayModeProvider>
          <AppBackgroundProvider>
            <ImagePreviewOverlayProvider previewEnabled={imagePreviewEnabled}>
              <PluginDevLeaveGuardProvider>
                <Layout>
                  <ResetListStateOnReload />
                  <Routes>
                    <Route path={ROUTE_PATH.library} element={<LibraryShell />}>
                      <Route index element={null} />
                      <Route path={ROUTE_SEGMENT.libraryDetail} element={<DetailPage />}>
                        <Route path={ROUTE_SEGMENT.detailActress} element={<ActressDetailPage />} />
                      </Route>
                    </Route>
                    <Route path={ROUTE_PATH.actresses} element={<ActressShell />}>
                      <Route index element={null} />
                      <Route
                        path={ROUTE_SEGMENT.actressConflicts}
                        element={<Navigate to={pendingCenterPath({ type: 'actress' })} replace />}
                      />
                      <Route path={ROUTE_SEGMENT.actressDetail} element={<ActressDetailPage />}>
                        <Route path={ROUTE_SEGMENT.actressVideo} element={<DetailPage />}>
                          <Route
                            path={ROUTE_SEGMENT.detailActress}
                            element={<ActressDetailPage />}
                          />
                        </Route>
                      </Route>
                    </Route>
                    <Route path={ROUTE_PATH.playlists} element={<PlaylistShell />}>
                      <Route index element={null} />
                      <Route path={ROUTE_SEGMENT.playlistDetail} element={<PlaylistDetailPage />}>
                        <Route path={ROUTE_SEGMENT.playlistVideo} element={<DetailPage />}>
                          <Route
                            path={ROUTE_SEGMENT.detailActress}
                            element={<ActressDetailPage />}
                          />
                        </Route>
                      </Route>
                    </Route>
                    <Route path={ROUTE_PATH.facetList} element={<FacetShell />}>
                      <Route index element={null} />
                      <Route
                        path={ROUTE_SEGMENT.organizationDetail}
                        element={
                          <FacetDetailRoute kind="organization">
                            <OrganizationDetailPage />
                          </FacetDetailRoute>
                        }
                      >
                        <Route path={ROUTE_SEGMENT.organizationVideo} element={<DetailPage />}>
                          <Route
                            path={ROUTE_SEGMENT.detailActress}
                            element={<ActressDetailPage />}
                          />
                        </Route>
                      </Route>
                      <Route
                        path={ROUTE_SEGMENT.directorDetail}
                        element={
                          <FacetDetailRoute kind="director">
                            <DirectorDetailPage />
                          </FacetDetailRoute>
                        }
                      >
                        <Route path={ROUTE_SEGMENT.directorVideo} element={<DetailPage />}>
                          <Route
                            path={ROUTE_SEGMENT.detailActress}
                            element={<ActressDetailPage />}
                          />
                        </Route>
                      </Route>
                      <Route
                        path={ROUTE_SEGMENT.seriesDetail}
                        element={
                          <FacetDetailRoute kind="series">
                            <SeriesDetailPage />
                          </FacetDetailRoute>
                        }
                      >
                        <Route path={ROUTE_SEGMENT.seriesVideo} element={<DetailPage />}>
                          <Route
                            path={ROUTE_SEGMENT.detailActress}
                            element={<ActressDetailPage />}
                          />
                        </Route>
                      </Route>
                    </Route>
                    <Route path={ROUTE_PATH.settings} element={<SettingsPage />}>
                      <Route index element={<Navigate to={settingsPath('overview')} replace />} />
                      {SETTINGS_GROUPS.flatMap((group) =>
                        group.tabs.map((tab) => (
                          <Route
                            key={`${group.id}:${tab.id}`}
                            path={`${group.id}/${tab.id}`}
                            element={<SettingsSectionOutlet />}
                          />
                        ))
                      )}
                      <Route path="plugin-dev" element={<SettingsPluginDevOutlet />} />
                      <Route
                        path="*"
                        element={<Navigate to={settingsPath('overview')} replace />}
                      />
                    </Route>
                    <Route path={ROUTE_PATH.pending} element={<PendingCenterShell />}>
                      <Route index element={null} />
                      <Route path={ROUTE_SEGMENT.detailActress} element={<ActressDetailPage />} />
                      <Route path={ROUTE_SEGMENT.pendingVideo} element={<DetailPage />}>
                        <Route path={ROUTE_SEGMENT.detailActress} element={<ActressDetailPage />} />
                      </Route>
                    </Route>
                    <Route path="*" element={<Navigate to={ROUTE_PATH.library} replace />} />
                  </Routes>
                </Layout>
              </PluginDevLeaveGuardProvider>
            </ImagePreviewOverlayProvider>
          </AppBackgroundProvider>
        </DisplayModeProvider>
      </AvatarAutoCropBatchProvider>
    </ToastProvider>
  )
}

export default function App(): JSX.Element {
  useEffect(() => installDisableInputSpellcheck(), [])

  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  )
}
