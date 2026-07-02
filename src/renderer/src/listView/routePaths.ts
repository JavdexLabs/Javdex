/**
 * Central route patterns for useMatch / ListDetailShell.
 * Pathnames for navigation live in listNavigation.ts and facetRoutes.ts.
 */
export const ROUTE_MATCH = {
  libraryDetailOpen: '/detail/*',
  libraryActressStack: '/detail/:id/actress/:actressId',
  playlistDetailOpen: '/playlists/:playlistId',
  playlistVideoStack: '/playlists/:playlistId/:id',
  playlistActressStack: '/playlists/:playlistId/:id/actress/:actressId',
  actressDetailOpen: '/actresses/:id',
  actressVideoStack: '/actresses/:id/:videoId',
  actressActressStack: '/actresses/:id/:videoId/actress/:actressId',
  facetDetailOpen: '/facet/:type/v/:valueKey',
  facetVideoStack: '/facet/:type/v/:valueKey/:id',
  facetActressStack: '/facet/:type/v/:valueKey/:id/actress/:actressId'
} as const
