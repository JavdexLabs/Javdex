import type {
  ClassificationEntityKind,
  ClassificationLink,
  ClassificationMergeInput
} from '@shared/classificationTypes'
import type Database from 'better-sqlite3'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'

export interface ClassificationMergeName {
  name: string
  normalized_name: string
}

export interface ClassificationMergeLink extends ClassificationLink {
  normalized_url: string
}

interface HierarchyEntity {
  id: number
  parentId: number | null
}

const HIERARCHY_CONFIG: Partial<
  Record<
    ClassificationEntityKind,
    { table: string; parentColumn: string; entityLabel: string }
  >
> = {
  organization: {
    table: 'organizations',
    parentColumn: 'parent_organization_id',
    entityLabel: '机构'
  },
  series: { table: 'series', parentColumn: 'parent_series_id', entityLabel: '系列' }
}

function isClassificationDescendant(
  database: Database.Database,
  kind: 'organization' | 'series',
  ancestorId: number,
  candidateId: number
): boolean {
  const config = HIERARCHY_CONFIG[kind]
  if (!config) return false
  return Boolean(
    database
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM ${config.table} WHERE ${config.parentColumn} = ?
           UNION
           SELECT entity.id
           FROM ${config.table} entity
           JOIN descendants child ON entity.${config.parentColumn} = child.id
         )
         SELECT 1 FROM descendants WHERE id = ?`
      )
      .get(ancestorId, candidateId)
  )
}

export function resolveClassificationMergeParent(
  database: Database.Database,
  kind: 'organization' | 'series',
  target: HierarchyEntity,
  source: HierarchyEntity
): number | null {
  const config = HIERARCHY_CONFIG[kind]
  if (!config) throw new Error('分类层级配置无效')
  const targetIsSourceDescendant = isClassificationDescendant(
    database,
    kind,
    source.id,
    target.id
  )
  if (targetIsSourceDescendant) {
    if (target.parentId !== source.id) {
      throw new Error(
        `目标${config.entityLabel}位于来源${config.entityLabel}的多级子层级中，` +
          `转移直接子${config.entityLabel}会形成循环；请先调整上级${config.entityLabel}`
      )
    }
    return source.parentId
  }
  if (isClassificationDescendant(database, kind, target.id, source.id)) {
    return target.parentId
  }
  return target.parentId ?? source.parentId
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
