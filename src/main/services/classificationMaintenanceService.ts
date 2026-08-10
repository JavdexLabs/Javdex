import type Database from 'better-sqlite3'
import type {
  OrganizationAssignmentInput,
  OrganizationAssignmentResult,
  OrganizationCreateInput,
  OrganizationLink,
  OrganizationLinkInput,
  OrganizationProfileInput,
  OrganizationRole,
  OrganizationStatus,
  OrganizationUpdateInput
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { getDb } from '../db/database'

const VIDEO_ROLE_FIELDS: Record<
  OrganizationRole,
  { idColumn: 'maker_organization_id' | 'publisher_organization_id'; textColumn: 'maker' | 'publisher' }
> = {
  maker: { idColumn: 'maker_organization_id', textColumn: 'maker' },
  publisher: { idColumn: 'publisher_organization_id', textColumn: 'publisher' }
}

const ORGANIZATION_STATUSES = new Set<OrganizationStatus>(['unknown', 'active', 'inactive'])

type StoredOrganization = {
  id: number
  main_name: string
  summary: string | null
  country_region: string | null
  founded_year: number | null
  ended_year: number | null
  status: OrganizationStatus
  parent_organization_id: number | null
}

type PreparedOrganizationProfile = {
  mainName: string
  aliases: string[]
  summary: string | null
  countryRegion: string | null
  foundedYear: number | null
  endedYear: number | null
  status: OrganizationStatus
  parentOrganizationId: number | null
  links: OrganizationLink[]
}

function requireRole(role: OrganizationRole): OrganizationRole {
  if (role !== 'maker' && role !== 'publisher') throw new Error('无效的机构角色')
  return role
}

function optionalText(value: string | null | undefined): string | null {
  return value?.trim() || null
}

function validateYear(value: number | null | undefined, label: string): number | null {
  if (value == null) return null
  if (!Number.isInteger(value) || value < 1 || value > 9999) {
    throw new Error(`${label}必须是有效年份`)
  }
  return value
}

function normalizeHttpLink(input: OrganizationLinkInput, position: number): OrganizationLink {
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

function normalizedUrl(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function prepareLinks(inputs: OrganizationLinkInput[]): OrganizationLink[] {
  const seen = new Set<string>()
  const links: OrganizationLink[] = []
  for (const input of inputs) {
    const link = normalizeHttpLink(input, links.length)
    const key = normalizedUrl(link.url)
    if (seen.has(key)) continue
    seen.add(key)
    links.push(link)
  }
  return links
}

function prepareNames(mainNameInput: string, aliasesInput: string[]): {
  mainName: string
  aliases: string[]
  normalizedNames: Array<{ name: string; normalizedName: string; type: 'main' | 'alias' }>
} {
  const mainName = mainNameInput.trim()
  const mainNormalized = normalizeClassificationName(mainName)
  const normalizedNames: Array<{
    name: string
    normalizedName: string
    type: 'main' | 'alias'
  }> = [{ name: mainName, normalizedName: mainNormalized, type: 'main' }]
  const seen = new Set([mainNormalized])
  const aliases: string[] = []
  for (const rawAlias of aliasesInput) {
    const alias = rawAlias.trim()
    if (!alias) continue
    const normalizedName = normalizeClassificationName(alias)
    if (seen.has(normalizedName)) continue
    seen.add(normalizedName)
    aliases.push(alias)
    normalizedNames.push({ name: alias, normalizedName, type: 'alias' })
  }
  return { mainName, aliases, normalizedNames }
}

function assertParentIsValid(
  database: Database.Database,
  organizationId: number | null,
  parentOrganizationId: number | null
): void {
  if (parentOrganizationId == null) return
  const parentExists = database.prepare('SELECT 1 FROM organizations WHERE id = ?').get(
    parentOrganizationId
  )
  if (!parentExists) throw new Error('上级机构不存在')
  if (organizationId == null) return
  if (parentOrganizationId === organizationId) throw new Error('上级机构不能是自身或形成循环')
  const descendant = database
    .prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM organizations WHERE parent_organization_id = ?
         UNION
         SELECT o.id
         FROM organizations o
         JOIN descendants d ON o.parent_organization_id = d.id
       )
       SELECT 1 FROM descendants WHERE id = ?`
    )
    .get(organizationId, parentOrganizationId)
  if (descendant) throw new Error('上级机构不能是自身或形成循环')
}

function assertNamesAvailable(
  database: Database.Database,
  normalizedNames: string[],
  organizationId?: number
): void {
  const findOwner = database.prepare(
    'SELECT organization_id FROM organization_name_ownership WHERE normalized_name = ?'
  )
  for (const normalizedName of normalizedNames) {
    const owner = findOwner.get(normalizedName) as { organization_id: number } | undefined
    if (owner && owner.organization_id !== organizationId) {
      throw new Error('名称已归属于其他机构')
    }
  }
}

function readStoredOrganization(database: Database.Database, id: number): StoredOrganization {
  const row = database
    .prepare(
      `SELECT id, main_name, summary, country_region, founded_year, ended_year,
              status, parent_organization_id
       FROM organizations WHERE id = ?`
    )
    .get(id) as StoredOrganization | undefined
  if (!row) throw new Error('机构不存在')
  return row
}

function readAliases(database: Database.Database, id: number): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM organization_names
         WHERE organization_id = ? AND type = 'alias'
         ORDER BY position, id`
      )
      .all(id) as Array<{ name: string }>
  ).map((row) => row.name)
}

function readLinks(database: Database.Database, id: number): OrganizationLink[] {
  return database
    .prepare(
      `SELECT label, url, position FROM organization_links
       WHERE organization_id = ? ORDER BY position, id`
    )
    .all(id) as OrganizationLink[]
}

function prepareProfile(
  input: OrganizationProfileInput,
  current?: StoredOrganization,
  currentAliases: string[] = [],
  currentLinks: OrganizationLink[] = []
): PreparedOrganizationProfile {
  const foundedYear =
    input.foundedYear === undefined
      ? current?.founded_year ?? null
      : validateYear(input.foundedYear, '成立年份')
  const endedYear =
    input.endedYear === undefined
      ? current?.ended_year ?? null
      : validateYear(input.endedYear, '停止年份')
  if (foundedYear != null && endedYear != null && foundedYear > endedYear) {
    throw new Error('成立年份不能晚于停止年份')
  }
  const status = input.status ?? current?.status ?? 'unknown'
  if (!ORGANIZATION_STATUSES.has(status)) throw new Error('机构状态无效')
  const names = prepareNames(input.mainName, input.aliases ?? currentAliases)
  return {
    mainName: names.mainName,
    aliases: names.aliases,
    summary:
      input.summary === undefined ? current?.summary ?? null : optionalText(input.summary),
    countryRegion:
      input.countryRegion === undefined
        ? current?.country_region ?? null
        : optionalText(input.countryRegion),
    foundedYear,
    endedYear,
    status,
    parentOrganizationId:
      input.parentOrganizationId === undefined
        ? current?.parent_organization_id ?? null
        : input.parentOrganizationId,
    links: prepareLinks(input.links ?? currentLinks)
  }
}

function writeNames(
  database: Database.Database,
  organizationId: number,
  mainName: string,
  aliases: string[]
): void {
  const names = prepareNames(mainName, aliases).normalizedNames
  assertNamesAvailable(
    database,
    names.map((name) => name.normalizedName),
    organizationId
  )
  database.prepare('DELETE FROM organization_names WHERE organization_id = ?').run(organizationId)
  database
    .prepare('DELETE FROM organization_name_ownership WHERE organization_id = ?')
    .run(organizationId)
  const insertName = database.prepare(
    `INSERT INTO organization_names (
       organization_id, name, normalized_name, type, position
     ) VALUES (?, ?, ?, ?, ?)`
  )
  const insertOwnership = database.prepare(
    `INSERT INTO organization_name_ownership (normalized_name, organization_id)
     VALUES (?, ?)`
  )
  names.forEach((name, position) => {
    insertName.run(
      organizationId,
      name.name,
      name.normalizedName,
      name.type,
      name.type === 'main' ? 0 : position - 1
    )
    insertOwnership.run(name.normalizedName, organizationId)
  })
}

function writeLinks(
  database: Database.Database,
  organizationId: number,
  links: OrganizationLink[]
): void {
  database.prepare('DELETE FROM organization_links WHERE organization_id = ?').run(organizationId)
  const insert = database.prepare(
    `INSERT INTO organization_links (
       organization_id, label, url, normalized_url, position
     ) VALUES (?, ?, ?, ?, ?)`
  )
  for (const link of links) {
    insert.run(organizationId, link.label, link.url, normalizedUrl(link.url), link.position)
  }
}

function createOrganizationRecord(
  database: Database.Database,
  input: OrganizationCreateInput
): number {
  const role = requireRole(input.role)
  const profile = prepareProfile(input)
  assertParentIsValid(database, null, profile.parentOrganizationId)
  const names = prepareNames(profile.mainName, profile.aliases)
  assertNamesAvailable(
    database,
    names.normalizedNames.map((name) => name.normalizedName)
  )
  const now = new Date().toISOString()
  const organizationId = Number(
    database
      .prepare(
        `INSERT INTO organizations (
           main_name, summary, country_region, founded_year, ended_year, status,
           parent_organization_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profile.mainName,
        profile.summary,
        profile.countryRegion,
        profile.foundedYear,
        profile.endedYear,
        profile.status,
        profile.parentOrganizationId,
        now,
        now
      ).lastInsertRowid
  )
  writeNames(database, organizationId, profile.mainName, profile.aliases)
  writeLinks(database, organizationId, profile.links)
  database
    .prepare('INSERT INTO organization_roles (organization_id, role) VALUES (?, ?)')
    .run(organizationId, role)
  return organizationId
}

export interface ClassificationMaintenanceService {
  createOrganization(input: OrganizationCreateInput): number
  updateOrganization(id: number, input: OrganizationUpdateInput): boolean
  assignVideoOrganization(
    videoId: number,
    role: OrganizationRole,
    assignment: OrganizationAssignmentInput | null
  ): OrganizationAssignmentResult
}

export const classificationMaintenanceService: ClassificationMaintenanceService = {
  createOrganization(input): number {
    const database = getDb()
    return database.transaction(() => createOrganizationRecord(database, input))()
  },

  updateOrganization(id, input): boolean {
    const database = getDb()
    return database.transaction(() => {
      const current = readStoredOrganization(database, id)
      const currentAliases = readAliases(database, id)
      const aliases = [...(input.aliases ?? currentAliases)]
      if (input.keepPreviousMainName && input.mainName.trim() !== current.main_name) {
        aliases.unshift(current.main_name)
      }
      const profile = prepareProfile({ ...input, aliases }, current, currentAliases, readLinks(database, id))
      assertParentIsValid(database, id, profile.parentOrganizationId)
      const names = prepareNames(profile.mainName, profile.aliases)
      assertNamesAvailable(
        database,
        names.normalizedNames.map((name) => name.normalizedName),
        id
      )
      const now = new Date().toISOString()
      database
        .prepare(
          `UPDATE organizations
           SET main_name = ?, summary = ?, country_region = ?, founded_year = ?,
               ended_year = ?, status = ?, parent_organization_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          profile.mainName,
          profile.summary,
          profile.countryRegion,
          profile.foundedYear,
          profile.endedYear,
          profile.status,
          profile.parentOrganizationId,
          now,
          id
        )
      writeNames(database, id, profile.mainName, profile.aliases)
      writeLinks(database, id, profile.links)
      database
        .prepare('UPDATE videos SET maker = ? WHERE maker_organization_id = ?')
        .run(profile.mainName, id)
      database
        .prepare('UPDATE videos SET publisher = ? WHERE publisher_organization_id = ?')
        .run(profile.mainName, id)
      return true
    })()
  },

  assignVideoOrganization(videoId, role, assignment): OrganizationAssignmentResult {
    const database = getDb()
    const validRole = requireRole(role)
    const fields = VIDEO_ROLE_FIELDS[validRole]
    return database.transaction(() => {
      if (!database.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId)) {
        throw new Error('影片不存在')
      }
      if (assignment == null) {
        database
          .prepare(
            `UPDATE videos
             SET ${fields.idColumn} = NULL, ${fields.textColumn} = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(new Date().toISOString(), videoId)
        return { organizationId: null, mainName: null }
      }

      let organizationId: number
      if ('organizationId' in assignment) {
        organizationId = assignment.organizationId
        readStoredOrganization(database, organizationId)
      } else {
        const name = assignment.createName.trim()
        const normalizedName = normalizeClassificationName(name)
        const existing = database
          .prepare(
            `SELECT organization_id FROM organization_name_ownership
             WHERE normalized_name = ?`
          )
          .get(normalizedName) as { organization_id: number } | undefined
        organizationId =
          existing?.organization_id ??
          createOrganizationRecord(database, { role: validRole, mainName: name })
      }
      database
        .prepare(
          `INSERT OR IGNORE INTO organization_roles (organization_id, role)
           VALUES (?, ?)`
        )
        .run(organizationId, validRole)
      const organization = readStoredOrganization(database, organizationId)
      database
        .prepare(
          `UPDATE videos
           SET ${fields.idColumn} = ?, ${fields.textColumn} = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(organizationId, organization.main_name, new Date().toISOString(), videoId)
      return { organizationId, mainName: organization.main_name }
    })()
  }
}
