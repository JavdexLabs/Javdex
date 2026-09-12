import type { ActressScrapeField, ActressScrapeResult } from '@shared/actressScrapeTypes'

/** Keep one actress scrape result inside the plugin-declared or user-selected field boundary. */
export function projectActressScrapeResult(
  result: ActressScrapeResult,
  fields: ReadonlySet<ActressScrapeField>
): ActressScrapeResult {
  const out: ActressScrapeResult = {}
  if (fields.has('avatar')) out.avatarUrl = result.avatarUrl
  if (fields.has('gallery')) out.galleryImageUrls = result.galleryImageUrls
  if (fields.has('birthDate')) out.birthDate = result.birthDate
  if (fields.has('nameZh')) out.nameZh = result.nameZh
  if (fields.has('nameEn')) out.nameEn = result.nameEn
  if (fields.has('debutDate')) out.debutDate = result.debutDate
  if (fields.has('heightCm')) out.heightCm = result.heightCm
  if (fields.has('measurements')) {
    out.bustCm = result.bustCm
    out.waistCm = result.waistCm
    out.hipCm = result.hipCm
  }
  if (fields.has('cupSize')) out.cupSize = result.cupSize
  if (fields.has('bloodType')) out.bloodType = result.bloodType
  if (fields.has('zodiac')) out.zodiac = result.zodiac
  if (fields.has('nationality')) out.nationality = result.nationality
  if (fields.has('profileSummary')) out.profileSummary = result.profileSummary
  if (fields.has('aliases')) out.aliases = result.aliases
  return out
}
