import type { TagListItem } from '@shared/commonTypes'
import { listManualTags, listTags } from '../db/tagRepo'

export interface TagQueryService {
  list(): TagListItem[]
  listManual(): TagListItem[]
}

export const tagQueryService: TagQueryService = {
  list: listTags,
  listManual: listManualTags
}
