/** Build the identity key shared by classification migration, maintenance, and scraping. */
export function normalizeClassificationName(name: string): string {
  const normalized = name.normalize('NFKC').replace(/\p{White_Space}+/gu, '').toLowerCase()
  if (!normalized) throw new Error('分类名称不能为空')
  return normalized
}
