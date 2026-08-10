/** Single source of truth for route patterns used by Routes, matchers, and builders. */
export const ROUTE_PATH = {
  library: '/',
  libraryDetail: '/detail/:id',
  libraryDetailOpen: '/detail/*',
  libraryActressStack: '/detail/:id/actress/:actressId',
  actresses: '/actresses',
  actressTree: '/actresses/*',
  actressDetail: '/actresses/:id',
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
  facetDetail: '/facet/:type/v/:valueKey',
  facetVideoStack: '/facet/:type/v/:valueKey/:id',
  facetActressStack: '/facet/:type/v/:valueKey/:id/actress/:actressId',
  organizationDetail: '/facet/:type/o/:organizationId',
  organizationVideoStack: '/facet/:type/o/:organizationId/:id',
  organizationActressStack: '/facet/:type/o/:organizationId/:id/actress/:actressId',
  settings: '/settings',
  settingsTree: '/settings/*',
  settingsGroup: '/settings/:group/:tab',
  settingsPluginDev: '/settings/plugin-dev'
} as const

export const ROUTE_SEGMENT = {
  libraryDetail: 'detail/:id',
  detailActress: 'actress/:actressId',
  actressDetail: ':id',
  actressConflicts: 'conflicts',
  actressVideo: ':videoId',
  playlistDetail: ':playlistId',
  playlistVideo: ':id',
  facetDetail: 'v/:valueKey',
  facetVideo: ':id',
  organizationDetail: 'o/:organizationId',
  organizationVideo: ':id'
} as const

export const ROUTE_MATCH = {
  libraryDetailOpen: ROUTE_PATH.libraryDetailOpen,
  libraryActressStack: ROUTE_PATH.libraryActressStack,
  playlistDetailOpen: ROUTE_PATH.playlistDetail,
  playlistVideoStack: ROUTE_PATH.playlistVideoStack,
  playlistActressStack: ROUTE_PATH.playlistActressStack,
  actressDetailOpen: ROUTE_PATH.actressDetail,
  actressConflicts: ROUTE_PATH.actressConflicts,
  actressVideoStack: ROUTE_PATH.actressVideoStack,
  actressActressStack: ROUTE_PATH.actressActressStack,
  facetDetailOpen: ROUTE_PATH.facetDetail,
  facetVideoStack: ROUTE_PATH.facetVideoStack,
  facetActressStack: ROUTE_PATH.facetActressStack,
  organizationDetailOpen: ROUTE_PATH.organizationDetail,
  organizationVideoStack: ROUTE_PATH.organizationVideoStack,
  organizationActressStack: ROUTE_PATH.organizationActressStack
} as const
