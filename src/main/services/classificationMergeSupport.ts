import type {
  ClassificationImageCleanupFailure,
  ClassificationLink,
  ClassificationMergeInput
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'

export interface ClassificationMergeName {
  name: string
  normalized_name: string
}

export interface ClassificationMergeLink extends ClassificationLink {
  normalized_url: string
}

export function assertClassificationMergeInput(
  input: ClassificationMergeInput,
  entityLabel: string
): void {
  if (
    !input ||
    !Number.isInteger(input.targetId) ||
    input.targetId <= 0 ||
    !Number.isInteger(input.sourceId) ||
    input.sourceId <= 0
  ) {
    throw new Error(`${entityLabel}合并参数无效`)
  }
  if (input.targetId === input.sourceId) throw new Error(`不能合并同一${entityLabel}`)
}

export function mergeClassificationAliases(
  targetMainName: string,
  targetAliases: readonly ClassificationMergeName[],
  sourceMainName: string,
  sourceAliases: readonly ClassificationMergeName[]
): string[] {
  const seen = new Set([normalizeClassificationName(targetMainName)])
  const aliases: string[] = []
  const append = (name: string, normalizedName?: string): void => {
    const normalized = normalizedName ?? normalizeClassificationName(name)
    if (seen.has(normalized)) return
    seen.add(normalized)
    aliases.push(name)
  }
  targetAliases.forEach((alias) => append(alias.name, alias.normalized_name))
  append(sourceMainName)
  sourceAliases.forEach((alias) => append(alias.name, alias.normalized_name))
  return aliases
}

export function mergeClassificationLinks(
  targetLinks: readonly ClassificationMergeLink[],
  sourceLinks: readonly ClassificationMergeLink[]
): ClassificationMergeLink[] {
  const seen = new Set<string>()
  const links: ClassificationMergeLink[] = []
  for (const link of [...targetLinks, ...sourceLinks]) {
    if (seen.has(link.normalized_url)) continue
    seen.add(link.normalized_url)
    links.push({ ...link, position: links.length })
  }
  return links
}

export function targetFirstMeaningfulText(
  target: string | null,
  source: string | null
): string | null {
  return target?.trim() ? target : source?.trim() ? source : null
}

export function obsoleteSourceImagePath(
  targetImagePath: string | null,
  sourceImagePath: string | null
): string | null {
  return targetImagePath && sourceImagePath && targetImagePath !== sourceImagePath
    ? sourceImagePath
    : null
}

export function cleanupClassificationImage(
  obsoleteImagePath: string | null,
  deleteStoredImage: (storedPath: string) => void
): ClassificationImageCleanupFailure[] {
  if (!obsoleteImagePath) return []
  try {
    deleteStoredImage(obsoleteImagePath)
    return []
  } catch (error) {
    return [
      {
        path: obsoleteImagePath,
        error: error instanceof Error ? error.message : String(error)
      }
    ]
  }
}
