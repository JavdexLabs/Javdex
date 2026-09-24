import type { VideoEditInput } from '@shared/videoTypes'

export function videoEditInputFromManageFields(fields: {
  title?: string | null
  summary?: string | null
  release_date?: string | null
  makerOrganization?: VideoEditInput['makerOrganization']
  publisherOrganization?: VideoEditInput['publisherOrganization']
  directorAssignment?: VideoEditInput['directorAssignment']
  seriesAssignment?: VideoEditInput['seriesAssignment']
  duration_seconds?: number | null
  rating?: number
  tags?: string[]
  actressesFemale?: string[]
  actressesMale?: string[]
  cover?: { kind: string }
  links?: VideoEditInput['links']
}): VideoEditInput {
  const input: VideoEditInput = {}
  if ('title' in fields) input.title = fields.title
  if ('summary' in fields) input.summary = fields.summary
  if ('release_date' in fields) input.release_date = fields.release_date
  if ('makerOrganization' in fields) input.makerOrganization = fields.makerOrganization
  if ('publisherOrganization' in fields) input.publisherOrganization = fields.publisherOrganization
  if ('directorAssignment' in fields) input.directorAssignment = fields.directorAssignment
  if ('seriesAssignment' in fields) input.seriesAssignment = fields.seriesAssignment
  if ('duration_seconds' in fields) input.duration_seconds = fields.duration_seconds
  if ('rating' in fields) input.rating = fields.rating
  if ('tags' in fields) input.tags = fields.tags
  if ('actressesFemale' in fields) input.actressesFemale = fields.actressesFemale
  if ('actressesMale' in fields) input.actressesMale = fields.actressesMale
  if ('links' in fields) input.links = fields.links
  return input
}
