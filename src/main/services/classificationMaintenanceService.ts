import type Database from 'better-sqlite3'
import type {
  DirectorAssignmentInput,
  DirectorAssignmentResult,
  DirectorProfileInput,
  DirectorStatus,
  DirectorUpdateInput,
  OrganizationAssignmentInput,
  OrganizationAssignmentResult,
  OrganizationCreateInput,
  OrganizationLink,
  OrganizationLinkInput,
  OrganizationProfileInput,
  OrganizationRole,
  OrganizationStatus,
  OrganizationUpdateInput,
  SeriesAssignmentInput,
  SeriesAssignmentResult,
  SeriesProfileInput,
  SeriesStatus,
  SeriesUpdateInput
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { getDb } from '../db/database'
import { writeDirectorLinks, writeDirectorNames } from './directorProfilePersistence'

const VIDEO_ROLE_FIELDS: Record<
  OrganizationRole,
  { idColumn: 'maker_organization_id' | 'publisher_organization_id'; textColumn: 'maker' | 'publisher' }
> = {
  maker: { idColumn: 'maker_organization_id', textColumn: 'maker' },
  publisher: { idColumn: 'publisher_organization_id', textColumn: 'publisher' }
}

const ORGANIZATION_STATUSES = new Set<OrganizationStatus>(['unknown', 'active', 'inactive'])
const DIRECTOR_STATUSES = new Set<DirectorStatus>([
  'unknown',
  'active',
  'paused',
  'retired',
  'deceased'
])
const SERIES_STATUSES = new Set<SeriesStatus>([
  'unknown',
  'ongoing',
  'completed',
  'discontinued'
])

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

type StoredDirector = {
  id: number
  main_name: string
  summary: string | null
  country_region: string | null
  birth_date: string | null
  death_date: string | null
  birth_place: string | null
  career_start_year: number | null
  career_end_year: number | null
  status: DirectorStatus
}

function validateDate(value: string | null | undefined, label: string): string | null {
  const date = optionalText(value)
  if (!date) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label}必须是有效日期`)
  if (Number(date.slice(0, 4)) < 1) throw new Error(`${label}必须是有效日期`)
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label}必须是有效日期`)
  }
  return date
}

function readStoredDirector(database: Database.Database, id: number): StoredDirector {
  const row = database
    .prepare(
      `SELECT id, main_name, summary, country_region, birth_date, death_date, birth_place,
              career_start_year, career_end_year, status FROM directors WHERE id = ?`
    )
    .get(id) as StoredDirector | undefined
  if (!row) throw new Error('导演不存在')
  return row
}

function readDirectorAliases(database: Database.Database, id: number): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM director_names WHERE director_id = ? AND type = 'alias'
         ORDER BY position, id`
      )
      .all(id) as Array<{ name: string }>
  ).map((item) => item.name)
}

function readDirectorLinks(database: Database.Database, id: number): OrganizationLink[] {
  return database
    .prepare(
      `SELECT label, url, position FROM director_links
       WHERE director_id = ? ORDER BY position, id`
    )
    .all(id) as OrganizationLink[]
}

function prepareDirectorProfile(
  input: DirectorProfileInput,
  current?: StoredDirector,
  aliases: string[] = [],
  links: OrganizationLink[] = []
): DirectorProfileInput & { aliases: string[]; links: OrganizationLink[]; status: DirectorStatus } {
  const names = prepareNames(input.mainName, input.aliases ?? aliases)
  const birthDate =
    input.birthDate === undefined
      ? current?.birth_date ?? null
      : validateDate(input.birthDate, '出生日期')
  const deathDate =
    input.deathDate === undefined
      ? current?.death_date ?? null
      : validateDate(input.deathDate, '去世日期')
  if (birthDate && deathDate && birthDate > deathDate) throw new Error('出生日期不能晚于去世日期')
  const careerStartYear =
    input.careerStartYear === undefined
      ? current?.career_start_year ?? null
      : validateYear(input.careerStartYear, '从业开始年份')
  const careerEndYear =
    input.careerEndYear === undefined
      ? current?.career_end_year ?? null
      : validateYear(input.careerEndYear, '从业结束年份')
  if (careerStartYear && careerEndYear && careerStartYear > careerEndYear) {
    throw new Error('从业开始年份不能晚于结束年份')
  }
  const status = input.status ?? current?.status ?? 'unknown'
  if (!DIRECTOR_STATUSES.has(status)) throw new Error('导演状态无效')
  return {
    mainName: names.mainName,
    aliases: names.aliases,
    summary: input.summary === undefined ? current?.summary ?? null : optionalText(input.summary),
    countryRegion:
      input.countryRegion === undefined
        ? current?.country_region ?? null
        : optionalText(input.countryRegion),
    birthDate,
    deathDate,
    birthPlace:
      input.birthPlace === undefined ? current?.birth_place ?? null : optionalText(input.birthPlace),
    careerStartYear,
    careerEndYear,
    status,
    links: prepareLinks(input.links ?? links)
  }
}

function createDirectorRecord(database: Database.Database, input: DirectorProfileInput): number {
  const profile = prepareDirectorProfile(input)
  const now = new Date().toISOString()
  const id = Number(
    database
      .prepare(
        `INSERT INTO directors (
           main_name, summary, country_region, birth_date, death_date, birth_place,
           career_start_year, career_end_year, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profile.mainName,
        profile.summary,
        profile.countryRegion,
        profile.birthDate,
        profile.deathDate,
        profile.birthPlace,
        profile.careerStartYear,
        profile.careerEndYear,
        profile.status,
        now,
        now
      ).lastInsertRowid
  )
  writeDirectorNames(database, id, profile.mainName, profile.aliases)
  writeDirectorLinks(database, id, profile.links)
  return id
}

type StoredSeries = {
  id: number
  main_name: string
  summary: string | null
  owner_organization_id: number | null
  parent_series_id: number | null
  start_year: number | null
  end_year: number | null
  status: SeriesStatus
}

type PreparedSeriesProfile = {
  mainName: string
  aliases: string[]
  summary: string | null
  ownerOrganizationId: number | null
  parentSeriesId: number | null
  startYear: number | null
  endYear: number | null
  status: SeriesStatus
  links: OrganizationLink[]
}

function readStoredSeries(database: Database.Database, id: number): StoredSeries {
  const row = database
    .prepare(
      `SELECT id, main_name, summary, owner_organization_id, parent_series_id,
              start_year, end_year, status
       FROM series WHERE id = ?`
    )
    .get(id) as StoredSeries | undefined
  if (!row) throw new Error('系列不存在')
  return row
}

function readSeriesAliases(database: Database.Database, id: number): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM series_names
         WHERE series_id = ? AND type = 'alias'
         ORDER BY position, id`
      )
      .all(id) as Array<{ name: string }>
  ).map((item) => item.name)
}

function readSeriesLinks(database: Database.Database, id: number): OrganizationLink[] {
  return database
    .prepare(
      `SELECT label, url, position FROM series_links
       WHERE series_id = ? ORDER BY position, id`
    )
    .all(id) as OrganizationLink[]
}

function assertSeriesOwnerExists(
  database: Database.Database,
  ownerOrganizationId: number | null
): void {
  if (ownerOrganizationId == null) return
  if (!database.prepare('SELECT 1 FROM organizations WHERE id = ?').get(ownerOrganizationId)) {
    throw new Error('所属机构不存在')
  }
}

function assertSeriesParentIsValid(
  database: Database.Database,
  seriesId: number | null,
  parentSeriesId: number | null
): void {
  if (parentSeriesId == null) return
  if (!database.prepare('SELECT 1 FROM series WHERE id = ?').get(parentSeriesId)) {
    throw new Error('上级系列不存在')
  }
  if (seriesId == null) return
  if (parentSeriesId === seriesId) throw new Error('上级系列不能是自身或形成循环')
  const descendant = database
    .prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM series WHERE parent_series_id = ?
         UNION
         SELECT s.id
         FROM series s
         JOIN descendants d ON s.parent_series_id = d.id
       )
       SELECT 1 FROM descendants WHERE id = ?`
    )
    .get(seriesId, parentSeriesId)
  if (descendant) throw new Error('上级系列不能是自身或形成循环')
}

function assertSeriesNamesAvailable(
  database: Database.Database,
  ownerOrganizationId: number | null,
  normalizedNames: string[],
  seriesId?: number
): void {
  const findOwner = database.prepare(
    `SELECT series_id FROM series_name_ownership
     WHERE COALESCE(owner_organization_id, 0) = COALESCE(?, 0)
       AND normalized_name = ?`
  )
  for (const normalizedName of normalizedNames) {
    const owner = findOwner.get(ownerOrganizationId, normalizedName) as
      | { series_id: number }
      | undefined
    if (owner && owner.series_id !== seriesId) {
      throw new Error('系列名称已归属于目标机构作用域内的其他系列')
    }
  }
}

function prepareSeriesProfile(
  input: SeriesProfileInput,
  current?: StoredSeries,
  aliases: string[] = [],
  links: OrganizationLink[] = []
): PreparedSeriesProfile {
  const names = prepareNames(input.mainName, input.aliases ?? aliases)
  const startYear =
    input.startYear === undefined
      ? current?.start_year ?? null
      : validateYear(input.startYear, '开始年份')
  const endYear =
    input.endYear === undefined ? current?.end_year ?? null : validateYear(input.endYear, '结束年份')
  if (startYear != null && endYear != null && startYear > endYear) {
    throw new Error('开始年份不能晚于结束年份')
  }
  const status = input.status ?? current?.status ?? 'unknown'
  if (!SERIES_STATUSES.has(status)) throw new Error('系列状态无效')
  return {
    mainName: names.mainName,
    aliases: names.aliases,
    summary: input.summary === undefined ? current?.summary ?? null : optionalText(input.summary),
    ownerOrganizationId:
      input.ownerOrganizationId === undefined
        ? current?.owner_organization_id ?? null
        : input.ownerOrganizationId,
    parentSeriesId:
      input.parentSeriesId === undefined ? current?.parent_series_id ?? null : input.parentSeriesId,
    startYear,
    endYear,
    status,
    links: prepareLinks(input.links ?? links)
  }
}

function writeSeriesNames(
  database: Database.Database,
  id: number,
  ownerOrganizationId: number | null,
  mainName: string,
  aliases: string[]
): void {
  const names = prepareNames(mainName, aliases).normalizedNames
  assertSeriesNamesAvailable(
    database,
    ownerOrganizationId,
    names.map((item) => item.normalizedName),
    id
  )
  database.prepare('DELETE FROM series_names WHERE series_id = ?').run(id)
  database.prepare('DELETE FROM series_name_ownership WHERE series_id = ?').run(id)
  const insertName = database.prepare(
    `INSERT INTO series_names (series_id, name, normalized_name, type, position)
     VALUES (?, ?, ?, ?, ?)`
  )
  const insertOwnership = database.prepare(
    `INSERT INTO series_name_ownership (owner_organization_id, normalized_name, series_id)
     VALUES (?, ?, ?)`
  )
  names.forEach((name, position) => {
    insertName.run(
      id,
      name.name,
      name.normalizedName,
      name.type,
      name.type === 'main' ? 0 : position - 1
    )
    insertOwnership.run(ownerOrganizationId, name.normalizedName, id)
  })
}

function writeSeriesLinks(
  database: Database.Database,
  id: number,
  links: OrganizationLink[]
): void {
  database.prepare('DELETE FROM series_links WHERE series_id = ?').run(id)
  const insert = database.prepare(
    `INSERT INTO series_links (series_id, label, url, normalized_url, position)
     VALUES (?, ?, ?, ?, ?)`
  )
  links.forEach((link) =>
    insert.run(id, link.label, link.url, normalizedUrl(link.url), link.position)
  )
}

function createSeriesRecord(database: Database.Database, input: SeriesProfileInput): number {
  const profile = prepareSeriesProfile(input)
  assertSeriesOwnerExists(database, profile.ownerOrganizationId)
  assertSeriesParentIsValid(database, null, profile.parentSeriesId)
  const names = prepareNames(profile.mainName, profile.aliases)
  assertSeriesNamesAvailable(
    database,
    profile.ownerOrganizationId,
    names.normalizedNames.map((item) => item.normalizedName)
  )
  const now = new Date().toISOString()
  const id = Number(
    database
      .prepare(
        `INSERT INTO series (
           main_name, summary, owner_organization_id, parent_series_id,
           start_year, end_year, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profile.mainName,
        profile.summary,
        profile.ownerOrganizationId,
        profile.parentSeriesId,
        profile.startYear,
        profile.endYear,
        profile.status,
        now,
        now
      ).lastInsertRowid
  )
  writeSeriesNames(database, id, profile.ownerOrganizationId, profile.mainName, profile.aliases)
  writeSeriesLinks(database, id, profile.links)
  return id
}

export interface ClassificationMaintenanceService {
  createOrganization(input: OrganizationCreateInput): number
  updateOrganization(id: number, input: OrganizationUpdateInput): boolean
  assignVideoOrganization(
    videoId: number,
    role: OrganizationRole,
    assignment: OrganizationAssignmentInput | null
  ): OrganizationAssignmentResult
  createDirector(input: DirectorProfileInput): number
  updateDirector(id: number, input: DirectorUpdateInput): boolean
  assignVideoDirector(
    videoId: number,
    assignment: DirectorAssignmentInput | null
  ): DirectorAssignmentResult
  createSeries(input: SeriesProfileInput): number
  updateSeries(id: number, input: SeriesUpdateInput): boolean
  assignVideoSeries(
    videoId: number,
    assignment: SeriesAssignmentInput | null
  ): SeriesAssignmentResult
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
  },

  createDirector(input): number {
    const database = getDb()
    return database.transaction(() => createDirectorRecord(database, input))()
  },

  updateDirector(id, input): boolean {
    const database = getDb()
    return database.transaction(() => {
      const current = readStoredDirector(database, id)
      const currentAliases = readDirectorAliases(database, id)
      const aliases = [...(input.aliases ?? currentAliases)]
      if (input.keepPreviousMainName && input.mainName.trim() !== current.main_name) {
        aliases.unshift(current.main_name)
      }
      const profile = prepareDirectorProfile(
        { ...input, aliases },
        current,
        currentAliases,
        readDirectorLinks(database, id)
      )
      const now = new Date().toISOString()
      database
        .prepare(
          `UPDATE directors
           SET main_name = ?, summary = ?, country_region = ?, birth_date = ?,
               death_date = ?, birth_place = ?, career_start_year = ?, career_end_year = ?,
               status = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          profile.mainName,
          profile.summary,
          profile.countryRegion,
          profile.birthDate,
          profile.deathDate,
          profile.birthPlace,
          profile.careerStartYear,
          profile.careerEndYear,
          profile.status,
          now,
          id
        )
      writeDirectorNames(database, id, profile.mainName, profile.aliases)
      writeDirectorLinks(database, id, profile.links)
      database.prepare('UPDATE videos SET director = ? WHERE director_id = ?').run(profile.mainName, id)
      return true
    })()
  },

  assignVideoDirector(videoId, assignment): DirectorAssignmentResult {
    const database = getDb()
    return database.transaction(() => {
      if (!database.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId)) {
        throw new Error('影片不存在')
      }
      if (assignment == null) {
        database
          .prepare('UPDATE videos SET director_id = NULL, director = NULL, updated_at = ? WHERE id = ?')
          .run(new Date().toISOString(), videoId)
        return { directorId: null, mainName: null }
      }
      const id =
        'directorId' in assignment
          ? assignment.directorId
          : createDirectorRecord(database, { mainName: assignment.createName })
      const director = readStoredDirector(database, id)
      database
        .prepare('UPDATE videos SET director_id = ?, director = ?, updated_at = ? WHERE id = ?')
        .run(id, director.main_name, new Date().toISOString(), videoId)
      return { directorId: id, mainName: director.main_name }
    })()
  },

  createSeries(input): number {
    const database = getDb()
    return database.transaction(() => createSeriesRecord(database, input))()
  },

  updateSeries(id, input): boolean {
    const database = getDb()
    return database.transaction(() => {
      const current = readStoredSeries(database, id)
      const currentAliases = readSeriesAliases(database, id)
      const aliases = [...(input.aliases ?? currentAliases)]
      if (input.keepPreviousMainName && input.mainName.trim() !== current.main_name) {
        aliases.unshift(current.main_name)
      }
      const profile = prepareSeriesProfile(
        { ...input, aliases },
        current,
        currentAliases,
        readSeriesLinks(database, id)
      )
      assertSeriesOwnerExists(database, profile.ownerOrganizationId)
      assertSeriesParentIsValid(database, id, profile.parentSeriesId)
      const names = prepareNames(profile.mainName, profile.aliases)
      assertSeriesNamesAvailable(
        database,
        profile.ownerOrganizationId,
        names.normalizedNames.map((item) => item.normalizedName),
        id
      )
      const now = new Date().toISOString()
      database
        .prepare(
          `UPDATE series
           SET main_name = ?, summary = ?, owner_organization_id = ?, parent_series_id = ?,
               start_year = ?, end_year = ?, status = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          profile.mainName,
          profile.summary,
          profile.ownerOrganizationId,
          profile.parentSeriesId,
          profile.startYear,
          profile.endYear,
          profile.status,
          now,
          id
        )
      writeSeriesNames(database, id, profile.ownerOrganizationId, profile.mainName, profile.aliases)
      writeSeriesLinks(database, id, profile.links)
      database.prepare('UPDATE videos SET series = ? WHERE series_id = ?').run(profile.mainName, id)
      return true
    })()
  },

  assignVideoSeries(videoId, assignment): SeriesAssignmentResult {
    const database = getDb()
    return database.transaction(() => {
      if (!database.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId)) {
        throw new Error('影片不存在')
      }
      if (assignment == null) {
        database
          .prepare('UPDATE videos SET series_id = NULL, series = NULL, updated_at = ? WHERE id = ?')
          .run(new Date().toISOString(), videoId)
        return { seriesId: null, mainName: null }
      }
      let id: number
      if ('seriesId' in assignment) {
        id = assignment.seriesId
      } else {
        const name = assignment.createName.trim()
        const normalizedName = normalizeClassificationName(name)
        const existing = database
          .prepare(
            `SELECT series_id FROM series_name_ownership
             WHERE owner_organization_id IS NULL AND normalized_name = ?`
          )
          .get(normalizedName) as { series_id: number } | undefined
        id = existing?.series_id ?? createSeriesRecord(database, { mainName: name })
      }
      const series = readStoredSeries(database, id)
      database
        .prepare('UPDATE videos SET series_id = ?, series = ?, updated_at = ? WHERE id = ?')
        .run(id, series.main_name, new Date().toISOString(), videoId)
      return { seriesId: id, mainName: series.main_name }
    })()
  }
}
