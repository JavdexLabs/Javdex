export type ScrapedStatus = 0 | 1 | 2

export type SortDir = 'asc' | 'desc'

export interface Tag {
  id: number
  name: string
}

export interface TagListItem extends Tag {
  video_count: number
}

/** Display-only label; never use a truncated label as a tag's identity or edit value. */
export interface TagLabel {
  id: number
  label: string
}

export interface TagOptionsQuery {
  search?: string
  offset?: number
  limit?: number
}

export interface TagOptionsPage {
  items: TagLabel[]
  hasMore: boolean
}

/** Alphabetical filter candidates with global active/visible video counts. */
export interface TagFilterOptionsPage {
  items: Array<TagLabel & { video_count: number }>
  hasMore: boolean
}
