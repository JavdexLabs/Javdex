import type { Query, QueryClient } from '@tanstack/react-query'
import type { HomeSnapshot } from '@shared/catalogTypes'
import type { VideoCard } from '@shared/videoTypes'
import { homeKeys, videoKeys } from './queryKeys'

interface CardPage { items: VideoCard[]; total: number }

/** Membership changes affect card flags, not the library's rows, order or count. */
export async function updateBuiltinPlaylistMembership(
  client: QueryClient, videoId: number, kind: 'favorites' | 'watch_later', selected: boolean
): Promise<void> {
  const field = kind === 'favorites' ? 'is_favorite' : 'is_watch_later'
  const update = <T extends VideoCard>(cards: T[]): T[] => cards.map(card =>
    card.id === videoId ? { ...card, [field]: Number(selected) } : card)
  const isCardPage = (query: Query): boolean =>
    (query.queryKey[0] === 'videos' && query.queryKey[1] === 'list'
      || query.queryKey[0] === 'home' && query.queryKey[1] === 'search')
    && Boolean((query.state.data as CardPage | undefined)?.items?.some(card => card.id === videoId))
  const isHomeSnapshot = (query: Query): boolean => {
    if (query.queryKey[0] !== 'home' || query.queryKey[1] !== 'snapshot') return false
    const snapshot = query.state.data as HomeSnapshot | undefined
    return Boolean(snapshot?.recent.some(card => card.id === videoId) || snapshot?.discovery.some(card => card.id === videoId))
  }
  // A read started before the write must not overwrite the confirmed membership.
  await client.cancelQueries({ predicate: query => isCardPage(query) || isHomeSnapshot(query) })
  client.setQueriesData<CardPage>({ predicate: isCardPage }, page => page && ({ ...page, items: update(page.items) }))
  client.setQueriesData<HomeSnapshot>({ predicate: isHomeSnapshot }, snapshot => snapshot && ({
    ...snapshot, recent: update(snapshot.recent), discovery: update(snapshot.discovery)
  }))
  // Other video reads can refresh on their next visit without refetching the current wall.
  void client.invalidateQueries({ queryKey: videoKeys.all, refetchType: 'none' })
  void client.invalidateQueries({ queryKey: homeKeys.all, refetchType: 'none' })
}
