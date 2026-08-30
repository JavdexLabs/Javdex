/** Single source of truth for route patterns used by Routes, matchers, and builders. */
export const ROUTE_PATH = {
  home: '/',
  homeVideoStack: '/home/video/:videoId',
  homeActressStack: '/home/video/:videoId/actress/:actressId',
  search: '/search',
  searchTree: '/search/*',
  searchVideoStack: '/search/video/:videoId',
  searchActressStack: '/search/video/:videoId/actress/:actressId',
  mediaLibrary: '/libraries/:libraryId',
  mediaLibraryTree: '/libraries/:libraryId/*',
  mediaLibraryVideoStack: '/libraries/:libraryId/video/:videoId',
  mediaLibraryActressStack:
    '/libraries/:libraryId/video/:videoId/actress/:actressId',
  /** Legacy media-library settings entry; redirects into the unified settings workspace. */
  mediaLibrarySettings: '/libraries/:libraryId/settings/:tab',
  /** Former named entry; redirects to the default active media library. */
  legacyLibrary: '/library',
  /** @deprecated `/` is now the home route. Kept until the old library shell is migrated. */
  library: '/',
  /** @deprecated Compatibility entry for the former single-library detail stack. */
  libraryDetail: '/detail/:id',
  /** @deprecated Compatibility entry for the former single-library detail stack. */
  libraryDetailOpen: '/detail/*',
  /** @deprecated Compatibility entry for the former single-library detail stack. */
  libraryActressStack: '/detail/:id/actress/:actressId',
  actresses: '/actresses',
  actressTree: '/actresses/*',
  actressDetail: '/actresses/:id',
  /** Legacy entry; the route only redirects into the unified pending inbox. */
  actressConflicts: '/actresses/conflicts',
  actressVideoStack: '/actresses/:id/:videoId',
  actressActressStack: '/actresses/:id/:videoId/actress/:actressId',
  playlists: '/playlists',
  playlistTree: '/playlists/*',
  playlistDetail: '/playlists/:playlistId',
  playlistVideoStack: '/playlists/:playlistId/:id',
  playlistActressStack: '/playlists/:playlistId/:id/actress/:actressId',
  facetTree: '/facet/:type/*',
  facetList: '/facet/:type',
  organizationDetail: '/facet/:type/o/:organizationId',
  organizationVideoStack: '/facet/:type/o/:organizationId/:id',
  organizationActressStack: '/facet/:type/o/:organizationId/:id/actress/:actressId',
  directorDetail: '/facet/director/d/:directorId',
  directorVideoStack: '/facet/director/d/:directorId/:id',
  directorActressStack: '/facet/director/d/:directorId/:id/actress/:actressId',
  seriesDetail: '/facet/series/s/:seriesId',
  seriesVideoStack: '/facet/series/s/:seriesId/:id',
  seriesActressStack: '/facet/series/s/:seriesId/:id/actress/:actressId',
  settings: '/settings',
  settingsTree: '/settings/*',
  settingsGroup: '/settings/:group/:tab',
  settingsPluginDev: '/settings/plugin-dev',
  pending: '/pending',
  pendingTree: '/pending/*',
  pendingVideoStack: '/pending/video/:videoId',
  pendingActressStack: '/pending/video/:videoId/actress/:actressId',
  /** Actress overlay opened from the pending inbox, not from a video. */
  pendingActressDetail: '/pending/actress/:actressId'
} as const

export const ROUTE_SEGMENT = {
  homeVideo: 'home/video/:videoId',
  searchVideo: 'video/:videoId',
  mediaLibraryVideo: 'video/:videoId',
  /** Legacy media-library settings segment. */
  mediaLibrarySettings: 'settings/:tab',
  /** @deprecated Compatibility segment for the former single-library detail stack. */
  libraryDetail: 'detail/:id',
  detailActress: 'actress/:actressId',
  actressDetail: ':id',
  actressConflicts: 'conflicts',
  actressVideo: ':videoId',
  playlistDetail: ':playlistId',
  playlistVideo: ':id',
  organizationDetail: 'o/:organizationId',
  organizationVideo: ':id',
  directorDetail: 'd/:directorId',
  directorVideo: ':id',
  seriesDetail: 's/:seriesId',
  seriesVideo: ':id',
  pendingVideo: 'video/:videoId'
} as const

export const ROUTE_MATCH = {
  homeVideoOpen: '/home/video/*',
  homeVideoStack: ROUTE_PATH.homeVideoStack,
  homeActressStack: ROUTE_PATH.homeActressStack,
  searchVideoOpen: '/search/video/*',
  searchVideoStack: ROUTE_PATH.searchVideoStack,
  searchActressStack: ROUTE_PATH.searchActressStack,
  mediaLibraryVideoOpen: '/libraries/:libraryId/video/*',
  mediaLibraryVideoStack: ROUTE_PATH.mediaLibraryVideoStack,
  mediaLibraryActressStack: ROUTE_PATH.mediaLibraryActressStack,
  mediaLibrarySettings: ROUTE_PATH.mediaLibrarySettings,
  /** @deprecated Compatibility matcher for the former single-library detail stack. */
  libraryDetailOpen: ROUTE_PATH.libraryDetailOpen,
  /** @deprecated Compatibility matcher for the former single-library detail stack. */
  libraryActressStack: ROUTE_PATH.libraryActressStack,
  playlistDetailOpen: ROUTE_PATH.playlistDetail,
  playlistVideoStack: ROUTE_PATH.playlistVideoStack,
  playlistActressStack: ROUTE_PATH.playlistActressStack,
  actressDetailOpen: ROUTE_PATH.actressDetail,
  actressVideoStack: ROUTE_PATH.actressVideoStack,
  actressActressStack: ROUTE_PATH.actressActressStack,
  organizationDetailOpen: ROUTE_PATH.organizationDetail,
  organizationVideoStack: ROUTE_PATH.organizationVideoStack,
  organizationActressStack: ROUTE_PATH.organizationActressStack,
  directorDetailOpen: ROUTE_PATH.directorDetail,
  directorVideoStack: ROUTE_PATH.directorVideoStack,
  directorActressStack: ROUTE_PATH.directorActressStack,
  seriesDetailOpen: ROUTE_PATH.seriesDetail,
  seriesVideoStack: ROUTE_PATH.seriesVideoStack,
  seriesActressStack: ROUTE_PATH.seriesActressStack,
  pendingVideoStack: ROUTE_PATH.pendingVideoStack,
  pendingActressStack: ROUTE_PATH.pendingActressStack,
  pendingActressDetail: ROUTE_PATH.pendingActressDetail
} as const
