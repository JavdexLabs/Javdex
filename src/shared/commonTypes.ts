export type ScrapedStatus = 0 | 1 | 2

export type SortDir = 'asc' | 'desc'

export interface Tag {
  id: number
  name: string
}

export interface TagListItem extends Tag {
  video_count: number
}
