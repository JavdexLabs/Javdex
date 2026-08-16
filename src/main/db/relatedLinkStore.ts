import type Database from 'better-sqlite3'
import type { RelatedLink, RelatedLinkInput } from '@shared/relatedLinkTypes'

export function prepareRelatedLinks(inputs: readonly RelatedLinkInput[]): RelatedLink[] {
  const seen = new Set<string>()
  const links: RelatedLink[] = []
  for (const input of inputs) {
    const link = normalizeRelatedHttpLink(input, links.length)
    const key = stripRelatedLinkHash(link.url)
    if (seen.has(key)) continue
    seen.add(key)
    links.push(link)
  }
  return links
}

export function writeRelatedLinks(
  database: Database.Database,
  table: string,
  entityIdColumn: string,
  entityId: number,
  links: readonly RelatedLink[]
): void {
  database.prepare(`DELETE FROM ${table} WHERE ${entityIdColumn} = ?`).run(entityId)
  const insert = database.prepare(
    `INSERT INTO ${table} (
       ${entityIdColumn}, label, url, normalized_url, position
     ) VALUES (?, ?, ?, ?, ?)`
  )
  for (const link of links) {
    insert.run(entityId, link.label, link.url, stripRelatedLinkHash(link.url), link.position)
  }
}

export function readRelatedLinks(
  database: Database.Database,
  table: string,
  entityIdColumn: string,
  entityId: number
): RelatedLink[] {
  return database
    .prepare(
      `SELECT label, url, position FROM ${table}
       WHERE ${entityIdColumn} = ?
       ORDER BY position, id`
    )
    .all(entityId) as RelatedLink[]
}

export function readRelatedMergeLinks(
  database: Database.Database,
  table: string,
  entityIdColumn: string,
  entityId: number
): Array<RelatedLink & { normalized_url: string }> {
  return database
    .prepare(
      `SELECT label, url, normalized_url, position FROM ${table}
       WHERE ${entityIdColumn} = ?
       ORDER BY position, id`
    )
    .all(entityId) as Array<RelatedLink & { normalized_url: string }>
}

export function replaceRelatedLinks(
  database: Database.Database,
  table: string,
  entityIdColumn: string,
  entityId: number,
  inputs: readonly RelatedLinkInput[]
): void {
  writeRelatedLinks(database, table, entityIdColumn, entityId, prepareRelatedLinks(inputs))
}

export function mergeRelatedLinks(
  targetLinks: readonly RelatedMergeLink[],
  sourceLinks: readonly RelatedMergeLink[]
): RelatedMergeLink[] {
  const seen = new Set<string>()
  const links: RelatedMergeLink[] = []
  for (const link of [...targetLinks, ...sourceLinks]) {
    if (seen.has(link.normalized_url)) continue
    seen.add(link.normalized_url)
    links.push({ ...link, position: links.length })
  }
  return links
}

export type RelatedMergeLink = RelatedLink & { normalized_url: string }

function stripRelatedLinkHash(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function normalizeRelatedHttpLink(input: RelatedLinkInput, position: number): RelatedLink {
  const rawUrl = input.url.trim()
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('相关链接必须是有效的 HTTP/HTTPS 地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('相关链接必须是有效的 HTTP/HTTPS 地址')
  }
  parsed.hash = ''
  return {
    label: input.label.trim() || parsed.hostname,
    url: rawUrl,
    position
  }
}
