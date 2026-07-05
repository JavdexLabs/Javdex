/**
 * Top-level list routes where ListDetailShell keeps a list page mounted beside
 * nested detail/stack routes.
 *
 * Route tree (pathname only; search params omitted):
 *
 * /                          LibraryPage
 * /detail/:id                + DetailPage (list stays mounted)
 * /detail/:id/actress/:aid   + ActressDetailPage stack
 *
 * /actresses                 ActressesPage
 * /actresses/:id             + ActressDetailPage
 * /actresses/:id/:videoId    + DetailPage stack
 *
 * /playlists                 PlaylistsPage
 * /playlists/:pid            + PlaylistDetailPage
 * /playlists/:pid/:id        + DetailPage stack
 *
 * /facet/:type               FacetListPage
 * /facet/:type/v/:key        + FacetDetailPage
 * /facet/:type/v/:key/:id    + DetailPage stack
 *
 * /settings/*                Settings (all library shells unmount)
 */

/** True only for list roots — not detail/stack overlays that keep the list mounted. */
export function isLibraryListSurfacePath(pathname: string): boolean {
  if (pathname === '/') return true
  if (pathname === '/actresses') return true
  if (pathname === '/playlists') return true
  return /^\/facet\/[^/]+$/.test(pathname)
}

/**
 * Refetch when landing on a list root from outside the list layer — e.g. Settings
 * → Library, or closing a detail overlay back to `/`. Skips list-to-list sidebar
 * hops (`/` → `/actresses`) and opening detail stacks (`/actresses` → `/actresses/1`).
 */
export function shouldRefetchLibraryOnRouteChange(
  previousPathname: string,
  nextPathname: string
): boolean {
  return (
    isLibraryListSurfacePath(nextPathname) && !isLibraryListSurfacePath(previousPathname)
  )
}
