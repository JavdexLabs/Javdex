import type { ActressListItem, ActressListPage } from '@shared/actressTypes'

export function flattenActressListPages(pages: readonly ActressListPage[]): ActressListItem[] {
  return pages.flatMap((page) => page.items)
}

export function nextActressPageOffset(
  pages: readonly ActressListPage[]
): number | undefined {
  const loaded = pages.reduce((count, page) => count + page.items.length, 0)
  const total = pages[0]?.total ?? 0
  return loaded < total ? loaded : undefined
}
