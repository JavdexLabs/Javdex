import type { WebCollection, WebVideo } from '@shared/webTypes'
export class WebCatalogQueryError extends Error {}
export interface WebBrowseQuery {
  page?: number
  search?: string
  library?: number
  actress?: number
  tag?: number
  playlist?: number
  year?: number
  sort?: 'recent' | 'released' | 'rating' | 'code'
}
export type WebHome = { discovery: WebVideo[]; recent: WebVideo[] }
export type WebCollections = { libraries: WebCollection[]; playlists: WebCollection[] }

export function normalizeWebSeed(seed: string): string {
  if (typeof seed !== 'string' || !seed || seed.length > 100) throw new WebCatalogQueryError('随机批次参数无效')
  return seed
}
export function parseWebBrowseQuery(query: URLSearchParams): WebBrowseQuery {
  const search = query.get('q')?.trim() ?? ''
  const sort = query.get('sort') ?? 'recent'
  if (search.length > 200) throw new WebCatalogQueryError('搜索词过长')
  if (!['recent','released','rating','code'].includes(sort)) throw new WebCatalogQueryError('排序参数无效')
  return { page:integer(query,'page') ?? 1, search, sort:sort as WebBrowseQuery['sort'],
    library:integer(query,'library'),actress:integer(query,'actress'),tag:integer(query,'tag'),
    playlist:integer(query,'playlist'),year:integer(query,'year') }
}
export function normalizeWebBrowseQuery(query: WebBrowseQuery): WebBrowseQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new WebCatalogQueryError('筛选参数无效')
  const result: WebBrowseQuery = {}
  for (const key of ['page','library','actress','tag','playlist','year'] as const) {
    const value=query[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 1000000000)) throw new WebCatalogQueryError('筛选参数无效')
    if (value !== undefined) result[key]=value
  }
  if (query.search !== undefined && typeof query.search !== 'string') throw new WebCatalogQueryError('搜索词过长')
  if (query.sort !== undefined && !['recent','released','rating','code'].includes(query.sort)) throw new WebCatalogQueryError('排序参数无效')
  result.search=query.search?.trim() ?? ''
  if (result.search.length > 200) throw new WebCatalogQueryError('搜索词过长')
  result.page ??= 1
  result.sort=query.sort ?? 'recent'
  return result
}
export function webBrowseParams(query: WebBrowseQuery): URLSearchParams {
  const result=new URLSearchParams()
  for(const [key,value] of Object.entries(query)) if(value !== undefined) result.set(key==='search'?'q':key,String(value))
  return result
}
export function integer(query: URLSearchParams, name: string): number | undefined {
  const value = query.get(name)
  if (value === null || value === '') return undefined
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > 1000000000
  )
    throw new WebCatalogQueryError('筛选参数无效')
  return Number(value)
}
