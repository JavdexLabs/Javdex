import type { FacetType } from '@shared/types'

export const FACET_LABEL: Record<FacetType, string> = {
  maker: '制作商',
  publisher: '发行商',
  series: '系列',
  director: '导演'
}

export const FACET_TYPES: FacetType[] = ['maker', 'publisher', 'series', 'director']

export function isFacetType(v: string | undefined): v is FacetType {
  return v === 'maker' || v === 'publisher' || v === 'series' || v === 'director'
}
