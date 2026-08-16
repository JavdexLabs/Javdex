import type { FacetType } from '@shared/libraryTypes'

export const FACET_LABEL: Record<FacetType, string> = {
  maker: '制作商',
  publisher: '发行商',
  series: '系列',
  director: '导演'
}

export const FACET_TYPES: FacetType[] = ['maker', 'publisher', 'series', 'director']

export type FacetDetailKind = 'organization' | 'director' | 'series'

export function isFacetType(v: string | undefined): v is FacetType {
  return v === 'maker' || v === 'publisher' || v === 'series' || v === 'director'
}

export function supportsFacetDetail(
  facetType: string | undefined,
  detailKind: FacetDetailKind
): boolean {
  if (detailKind === 'organization') {
    return facetType === 'maker' || facetType === 'publisher'
  }
  return facetType === detailKind
}
