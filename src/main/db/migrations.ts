import type Database from 'better-sqlite3'
import { normalizeActressName } from './actressNameNormalization'
import { normalizeClassificationName } from '../../shared/classificationNameNormalization'
import { normalizeLocalPathIdentity } from '../../shared/localPathIdentity'
import { normalizeRelatedLinkUrl } from '../../shared/relatedLinkUrl'
import { normalizeVideoCode } from '../../shared/videoCode'
import { buildVideoResourceSourceIdentity } from '../../shared/videoResourceIdentity'
import {
  CLASSIFICATION_V8_SCHEMA_SQL,
  AGENT_METADATA_SCHEMA_SQL,
  AGENT_PLATFORM_SCHEMA_SQL,
  AGENT_RESOURCE_CLEANUP_SCHEMA_SQL,
  MEDIA_LIBRARY_CORE_SCHEMA_SQL,
  MEDIA_LIBRARY_MEMBERSHIP_SCHEMA_SQL,
  MEDIA_LIBRARY_PENDING_SCAN_SCHEMA_SQL,
  MEDIA_LIBRARY_SCAN_SCHEMA_SQL,
  MEDIA_LIBRARY_VIDEO_RESOURCES_SCHEMA_SQL,
  PENDING_RESOURCE_IDENTITIES_SCHEMA_SQL,
  PENDING_LOCAL_FILE_DELETIONS_SCHEMA_SQL,
  PENDING_VIDEO_DECISIONS_SCHEMA_SQL,
  RELATED_LINKS_SCHEMA_SQL,
  SCHEMA_SQL,
  SCAN_AUDIT_ENTRIES_V18_SCHEMA_SQL,
  VIDEO_SOURCES_SCHEMA_SQL
} from './schema'

export const CURRENT_SCHEMA_VERSION = 18

type Migration = {
  version: number
  migrate: (database: Database.Database) => void
}

function columnNames(database: Database.Database, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  )
}

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  )
}

function migrateToV2(database: Database.Database): void {
  const cols = columnNames(database, 'actresses')
  if (!cols.has('avatar_source_path')) {
    database.exec('ALTER TABLE actresses ADD COLUMN avatar_source_path TEXT')
  }
  if (!cols.has('avatar_crop_json')) {
    database.exec('ALTER TABLE actresses ADD COLUMN avatar_crop_json TEXT')
  }
}

function migrateToV3(database: Database.Database): void {
  if (!tableExists(database, 'actresses') || !tableExists(database, 'actress_names')) return

  const migrateNames = database.transaction(() => {
    database.exec(`
      DELETE FROM actress_names
      WHERE type = 'main'
        AND NOT EXISTS (
          SELECT 1
          FROM actresses
          WHERE actresses.id = actress_names.actress_id
            AND actresses.main_name = actress_names.name
        );

      INSERT OR IGNORE INTO actress_names (actress_id, name, type, is_primary)
      SELECT id, main_name, 'main', 1
      FROM actresses;

      UPDATE actress_names
      SET is_primary = 1
      WHERE type = 'main';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_actress_names_one_main
      ON actress_names(actress_id)
      WHERE type = 'main';
    `)
  })
  migrateNames()
}

function migrateToV4(database: Database.Database): void {
  if (!tableExists(database, 'actresses')) return

  const migrateScrapeStatus = database.transaction(() => {
    let cols = columnNames(database, 'actresses')
    if (!cols.has('scraped_status')) {
      database.exec(
        `ALTER TABLE actresses
         ADD COLUMN scraped_status INTEGER NOT NULL DEFAULT 0
         CHECK(scraped_status IN (0, 1, 2))`
      )
      cols = columnNames(database, 'actresses')
    }

    const evidenceConditions: string[] = []
    for (const column of [
      'avatar_path',
      'avatar_source_path',
      'poster_path',
      'birth_date',
      'debut_date',
      'cup_size',
      'blood_type',
      'zodiac',
      'nationality',
      'profile_summary'
    ]) {
      if (cols.has(column)) {
        evidenceConditions.push(`(${column} IS NOT NULL AND trim(${column}) != '')`)
      }
    }
    for (const column of ['height_cm', 'bust_cm', 'waist_cm', 'hip_cm']) {
      if (cols.has(column)) evidenceConditions.push(`${column} IS NOT NULL`)
    }
    if (tableExists(database, 'actress_gallery_assets')) {
      const galleryCols = columnNames(database, 'actress_gallery_assets')
      const galleryAssetConditions = ['remote_url', 'local_path']
        .filter((column) => galleryCols.has(column))
        .map((column) => `(${column} IS NOT NULL AND trim(${column}) != '')`)
      if (galleryAssetConditions.length > 0) {
        evidenceConditions.push(
          `EXISTS (
             SELECT 1
             FROM actress_gallery_assets
             WHERE actress_id = actresses.id
               AND (${galleryAssetConditions.join(' OR ')})
           )`
        )
      }
    }
    if (tableExists(database, 'actress_names')) {
      evidenceConditions.push(
        `EXISTS (
           SELECT 1
           FROM actress_names
           WHERE actress_id = actresses.id
             AND type != 'main'
             AND trim(name) != ''
         )`
      )
    }

    if (cols.has('last_scraped_at')) {
      const hasSuccessTime =
        "(last_scraped_at IS NOT NULL AND trim(last_scraped_at) != '')"
      const hasEvidence =
        evidenceConditions.length > 0 ? `(${evidenceConditions.join(' OR ')})` : '0'
      const isMigratedSuccess = `(${hasSuccessTime} AND ${hasEvidence})`
      database.exec(`
        UPDATE actresses
        SET scraped_status = CASE WHEN ${isMigratedSuccess} THEN 1 ELSE 0 END,
            last_scraped_at = CASE WHEN ${isMigratedSuccess} THEN last_scraped_at ELSE NULL END
      `)
    } else {
      database.exec('UPDATE actresses SET scraped_status = 0')
    }

    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_actresses_scraped_status ON actresses(scraped_status)'
    )
  })
  migrateScrapeStatus()
}

type LegacyActressName = {
  actress_id: number
  name: string
  type: string
  locale: string | null
  source: string | null
  is_primary: number
}

function migrateToV5(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS actress_name_ownership (
      normalized_name TEXT PRIMARY KEY CHECK(length(normalized_name) > 0),
      actress_id INTEGER NOT NULL,
      FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_actress_name_ownership_actress_id
      ON actress_name_ownership(actress_id);

    CREATE TABLE IF NOT EXISTS pending_actress_name_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
      actress_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      locale TEXT,
      source TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE,
      UNIQUE (normalized_name, actress_id, name, type)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_actress_name_claims_normalized
      ON pending_actress_name_claims(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_pending_actress_name_claims_actress_id
      ON pending_actress_name_claims(actress_id);
  `)

  if (!tableExists(database, 'actress_names')) return

  database.exec(`
    DELETE FROM actress_names
    WHERE type = 'main'
      AND NOT EXISTS (
        SELECT 1
        FROM actresses
        WHERE actresses.id = actress_names.actress_id
          AND actresses.main_name = actress_names.name
      );

    INSERT OR IGNORE INTO actress_names (actress_id, name, type, is_primary)
    SELECT id, main_name, 'main', 1
    FROM actresses;

    UPDATE actress_names
    SET is_primary = 1
    WHERE type = 'main';
  `)

  const groups = new Map<string, LegacyActressName[]>()
  const names = database
    .prepare(
      `SELECT actress_id, name, type, locale, source, is_primary
       FROM actress_names
       ORDER BY id`
    )
    .all() as LegacyActressName[]

  for (const name of names) {
    let normalizedName: string
    try {
      normalizedName = normalizeActressName(name.name)
    } catch {
      continue
    }
    const existing = groups.get(normalizedName)
    if (existing) existing.push(name)
    else groups.set(normalizedName, [name])
  }

  const insertOwnership = database.prepare(
    `INSERT INTO actress_name_ownership (normalized_name, actress_id)
     VALUES (?, ?)`
  )
  const insertPendingClaim = database.prepare(
    `INSERT INTO pending_actress_name_claims (
       normalized_name, actress_id, name, type, locale, source, is_primary
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )

  for (const [normalizedName, claims] of groups) {
    const actressIds = new Set(claims.map((claim) => claim.actress_id))
    if (actressIds.size === 1) {
      insertOwnership.run(normalizedName, claims[0].actress_id)
      continue
    }
    for (const claim of claims) {
      insertPendingClaim.run(
        normalizedName,
        claim.actress_id,
        claim.name,
        claim.type,
        claim.locale,
        claim.source,
        claim.is_primary
      )
    }
  }
}

function migrateToV6(database: Database.Database): void {
  const actressColumns = columnNames(database, 'actresses')
  if (!actressColumns.has('revision')) {
    database.exec('ALTER TABLE actresses ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
  }
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_actresses_revision_after_update
    AFTER UPDATE ON actresses
    WHEN NEW.revision = OLD.revision
    BEGIN
      UPDATE actresses SET revision = OLD.revision + 1 WHERE id = NEW.id;
    END;

    CREATE TABLE IF NOT EXISTS pending_actress_scrapes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actress_id INTEGER NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 1,
      target_actress_revision INTEGER NOT NULL,
      plugin_name TEXT NOT NULL,
      plugin_source TEXT NOT NULL CHECK(plugin_source IN ('builtin', 'user', 'composite')),
      plugin_version TEXT,
      query_name TEXT NOT NULL,
      selected_fields_json TEXT NOT NULL,
      applicable_fields_json TEXT NOT NULL,
      update_mode TEXT NOT NULL CHECK(update_mode IN ('replace', 'fillEmpty', 'replaceIfPresent')),
      result_json TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      batch_job_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pending_actress_scrapes_created_at
      ON pending_actress_scrapes(created_at);

    CREATE TABLE IF NOT EXISTS pending_actress_scrape_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pending_scrape_id INTEGER NOT NULL,
      normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
      name TEXT NOT NULL,
      name_type TEXT NOT NULL CHECK(name_type IN ('main', 'zh', 'en', 'alias')),
      FOREIGN KEY (pending_scrape_id) REFERENCES pending_actress_scrapes(id) ON DELETE CASCADE,
      UNIQUE (pending_scrape_id, normalized_name, name, name_type)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_actress_scrape_conflicts_name
      ON pending_actress_scrape_conflicts(normalized_name);

    CREATE TABLE IF NOT EXISTS pending_actress_scrape_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pending_scrape_id INTEGER NOT NULL,
      field TEXT NOT NULL CHECK(field IN ('avatar', 'gallery')),
      position INTEGER NOT NULL DEFAULT 0,
      remote_url TEXT,
      staged_path TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      FOREIGN KEY (pending_scrape_id) REFERENCES pending_actress_scrapes(id) ON DELETE CASCADE,
      UNIQUE (pending_scrape_id, field, position)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_actress_scrape_resources_pending
      ON pending_actress_scrape_resources(pending_scrape_id);
  `)
}

function migrateToV7(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS video_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('local', 'direct', 'web', 'magnet', 'ed2k')),
      locator TEXT NOT NULL,
      resource_key TEXT NOT NULL UNIQUE,
      size_bytes INTEGER,
      duration_seconds INTEGER,
      file_mtime_ms INTEGER,
      display_name TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_video_resources_video_id ON video_resources(video_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_resources_key ON video_resources(resource_key);
    CREATE INDEX IF NOT EXISTS idx_video_resources_primary ON video_resources(video_id, is_primary);
    CREATE INDEX IF NOT EXISTS idx_video_resources_kind ON video_resources(kind);
  `)

  if (tableExists(database, 'video_files')) {
    database.exec(`
      INSERT OR IGNORE INTO video_resources (
        id, video_id, kind, locator, resource_key, size_bytes, duration_seconds,
        file_mtime_ms, display_name, is_primary, add_time
      )
      SELECT
        id, video_id, 'local', file_path, 'local:' || file_path, file_size,
        file_duration_seconds, file_mtime_ms, label, is_primary, add_time
      FROM video_files;
      DROP TABLE video_files;
    `)
    return
  }

  const videoColumns = columnNames(database, 'videos')
  if (!videoColumns.has('file_path')) return
  database.exec(`
    INSERT INTO video_resources (
      video_id, kind, locator, resource_key, size_bytes, duration_seconds,
      file_mtime_ms, display_name, is_primary, add_time
    )
    SELECT
      id, 'local', file_path, 'local:' || file_path,
      ${videoColumns.has('file_size') ? 'file_size' : 'NULL'},
      ${videoColumns.has('duration_seconds') ? 'duration_seconds' : 'NULL'},
      NULL, NULL, 1, add_time
    FROM videos;
    DROP INDEX IF EXISTS idx_videos_file_path;
    ALTER TABLE videos DROP COLUMN file_path;
  `)
  if (videoColumns.has('file_size')) {
    database.exec('ALTER TABLE videos DROP COLUMN file_size')
  }
}

type ClassificationKind = 'organization' | 'director' | 'series'
type OrganizationRole = 'maker' | 'publisher'

type LegacyNameVariant = {
  name: string
  videoIds: Set<number>
}

type LegacyNameGroup = {
  normalizedName: string
  variants: Map<string, LegacyNameVariant>
  roles: Set<OrganizationRole>
}

function compareStableText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function addLegacyClassificationName(
  groups: Map<string, LegacyNameGroup>,
  rawName: string,
  videoId?: number,
  role?: OrganizationRole
): void {
  const name = rawName.trim()
  let normalizedName: string
  try {
    normalizedName = normalizeClassificationName(name)
  } catch {
    return
  }

  let group = groups.get(normalizedName)
  if (!group) {
    group = {
      normalizedName,
      variants: new Map(),
      roles: new Set()
    }
    groups.set(normalizedName, group)
  }
  let variant = group.variants.get(name)
  if (!variant) {
    variant = { name, videoIds: new Set() }
    group.variants.set(name, variant)
  }
  if (videoId !== undefined) variant.videoIds.add(videoId)
  if (role) group.roles.add(role)
}

function collectLegacyClassificationGroups(
  database: Database.Database,
  kind: ClassificationKind
): Map<string, LegacyNameGroup> {
  const groups = new Map<string, LegacyNameGroup>()
  if (tableExists(database, 'videos')) {
    const columns = columnNames(database, 'videos')
    const fields: Array<{ column: string; role?: OrganizationRole }> =
      kind === 'organization'
        ? [
            { column: 'maker', role: 'maker' },
            { column: 'publisher', role: 'publisher' }
          ]
        : [{ column: kind === 'director' ? 'director' : 'series' }]

    for (const field of fields) {
      if (!columns.has(field.column)) continue
      const rows = database
        .prepare(
          `SELECT id, ${field.column} AS name
           FROM videos
           WHERE ${field.column} IS NOT NULL`
        )
        .all() as Array<{ id: number; name: string }>
      for (const row of rows) {
        addLegacyClassificationName(groups, row.name, row.id, field.role)
      }
    }
  }

  if (tableExists(database, 'facet_entries')) {
    const facetTypes =
      kind === 'organization' ? ['maker', 'publisher'] : [kind === 'director' ? 'director' : 'series']
    const placeholders = facetTypes.map(() => '?').join(', ')
    const rows = database
      .prepare(
        `SELECT type, value
         FROM facet_entries
         WHERE type IN (${placeholders})`
      )
      .all(...facetTypes) as Array<{ type: OrganizationRole | 'director' | 'series'; value: string }>
    for (const row of rows) {
      const role = row.type === 'maker' || row.type === 'publisher' ? row.type : undefined
      addLegacyClassificationName(groups, row.value, undefined, role)
    }
  }
  return groups
}

function orderedLegacyVariants(group: LegacyNameGroup): LegacyNameVariant[] {
  return [...group.variants.values()].sort((left, right) => {
    const countDifference = right.videoIds.size - left.videoIds.size
    return countDifference || compareStableText(left.name, right.name)
  })
}

function migrateLegacyNameGroups(
  groups: Map<string, LegacyNameGroup>,
  insertEntity: (mainName: string) => number,
  insertName: (
    entityId: number,
    name: string,
    normalizedName: string,
    type: 'main' | 'alias',
    position: number
  ) => void,
  afterEntity: (group: LegacyNameGroup, entityId: number) => void = () => undefined
): Map<string, number> {
  const entityIds = new Map<string, number>()
  for (const group of [...groups.values()].sort((left, right) =>
    compareStableText(left.normalizedName, right.normalizedName)
  )) {
    const variants = orderedLegacyVariants(group)
    const mainName = variants[0].name
    const entityId = insertEntity(mainName)
    entityIds.set(group.normalizedName, entityId)
    insertName(entityId, mainName, group.normalizedName, 'main', 0)
    variants
      .slice(1)
      .sort((left, right) => compareStableText(left.name, right.name))
      .forEach((variant, position) => {
        insertName(entityId, variant.name, group.normalizedName, 'alias', position)
      })
    afterEntity(group, entityId)
  }
  return entityIds
}

const CLASSIFICATION_VIDEO_REFERENCES = [
  {
    source: 'maker',
    target: 'maker_organization_id',
    targetTable: 'organizations',
    kind: 'organization'
  },
  {
    source: 'publisher',
    target: 'publisher_organization_id',
    targetTable: 'organizations',
    kind: 'organization'
  },
  { source: 'series', target: 'series_id', targetTable: 'series', kind: 'series' },
  { source: 'director', target: 'director_id', targetTable: 'directors', kind: 'director' }
] as const

function addClassificationVideoReferenceColumns(database: Database.Database): void {
  if (!tableExists(database, 'videos')) return
  let columns = columnNames(database, 'videos')
  for (const reference of CLASSIFICATION_VIDEO_REFERENCES) {
    if (columns.has(reference.target)) continue
    database.exec(
      `ALTER TABLE videos ADD COLUMN ${reference.target} INTEGER REFERENCES ${reference.targetTable}(id) ON DELETE SET NULL`
    )
    columns = columnNames(database, 'videos')
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_videos_maker_organization_id
      ON videos(maker_organization_id);
    CREATE INDEX IF NOT EXISTS idx_videos_publisher_organization_id
      ON videos(publisher_organization_id);
    CREATE INDEX IF NOT EXISTS idx_videos_series_id ON videos(series_id);
    CREATE INDEX IF NOT EXISTS idx_videos_director_id ON videos(director_id);
  `)
}

function migrateOrganizations(database: Database.Database): Map<string, number> {
  const groups = collectLegacyClassificationGroups(database, 'organization')
  const insertOrganization = database.prepare('INSERT INTO organizations (main_name) VALUES (?)')
  const insertName = database.prepare(
    `INSERT INTO organization_names (
       organization_id, name, normalized_name, type, position
     ) VALUES (?, ?, ?, ?, ?)`
  )
  const insertOwnership = database.prepare(
    `INSERT INTO organization_name_ownership (normalized_name, organization_id)
     VALUES (?, ?)`
  )
  const insertRole = database.prepare(
    'INSERT INTO organization_roles (organization_id, role) VALUES (?, ?)'
  )

  return migrateLegacyNameGroups(
    groups,
    (mainName) => Number(insertOrganization.run(mainName).lastInsertRowid),
    (organizationId, name, normalizedName, type, position) => {
      insertName.run(organizationId, name, normalizedName, type, position)
    },
    (group, organizationId) => {
      insertOwnership.run(group.normalizedName, organizationId)
      for (const role of [...group.roles].sort(compareStableText)) {
        insertRole.run(organizationId, role)
      }
    }
  )
}

function migrateDirectors(database: Database.Database): Map<string, number> {
  const groups = collectLegacyClassificationGroups(database, 'director')
  const insertDirector = database.prepare('INSERT INTO directors (main_name) VALUES (?)')
  const insertName = database.prepare(
    `INSERT INTO director_names (director_id, name, normalized_name, type, position)
     VALUES (?, ?, ?, ?, ?)`
  )

  return migrateLegacyNameGroups(
    groups,
    (mainName) => Number(insertDirector.run(mainName).lastInsertRowid),
    (directorId, name, normalizedName, type, position) => {
      insertName.run(directorId, name, normalizedName, type, position)
    }
  )
}

function migrateSeries(database: Database.Database): Map<string, number> {
  const groups = collectLegacyClassificationGroups(database, 'series')
  const insertSeries = database.prepare('INSERT INTO series (main_name) VALUES (?)')
  const insertName = database.prepare(
    `INSERT INTO series_names (series_id, name, normalized_name, type, position)
     VALUES (?, ?, ?, ?, ?)`
  )
  const insertOwnership = database.prepare(
    `INSERT INTO series_name_ownership (
       owner_organization_id, normalized_name, series_id
     ) VALUES (NULL, ?, ?)`
  )

  return migrateLegacyNameGroups(
    groups,
    (mainName) => Number(insertSeries.run(mainName).lastInsertRowid),
    (seriesId, name, normalizedName, type, position) => {
      insertName.run(seriesId, name, normalizedName, type, position)
    },
    (group, seriesId) => insertOwnership.run(group.normalizedName, seriesId)
  )
}

function migrateVideoClassificationReferences(
  database: Database.Database,
  organizationIds: Map<string, number>,
  directorIds: Map<string, number>,
  seriesIds: Map<string, number>
): void {
  if (!tableExists(database, 'videos')) return
  const columns = columnNames(database, 'videos')
  const idsByKind = { organization: organizationIds, director: directorIds, series: seriesIds }
  for (const reference of CLASSIFICATION_VIDEO_REFERENCES) {
    if (!columns.has(reference.source) || !columns.has(reference.target)) continue
    const rows = database
      .prepare(
        `SELECT id, ${reference.source} AS name FROM videos WHERE ${reference.source} IS NOT NULL`
      )
      .all() as Array<{ id: number; name: string }>
    const update = database.prepare(`UPDATE videos SET ${reference.target} = ? WHERE id = ?`)
    for (const row of rows) {
      let normalizedName: string
      try {
        normalizedName = normalizeClassificationName(row.name.trim())
      } catch {
        continue
      }
      const entityId = idsByKind[reference.kind].get(normalizedName)
      if (entityId !== undefined) update.run(entityId, row.id)
    }
  }
}

function migrateToV8(database: Database.Database): void {
  database.exec(CLASSIFICATION_V8_SCHEMA_SQL)
  addClassificationVideoReferenceColumns(database)
  const organizationIds = migrateOrganizations(database)
  const directorIds = migrateDirectors(database)
  const seriesIds = migrateSeries(database)
  migrateVideoClassificationReferences(database, organizationIds, directorIds, seriesIds)
}

function migrateToV9(database: Database.Database): void {
  if (tableExists(database, 'videos')) {
    database.exec(`
      DROP INDEX IF EXISTS idx_videos_maker;
      DROP INDEX IF EXISTS idx_videos_publisher;
      DROP INDEX IF EXISTS idx_videos_series;
      DROP INDEX IF EXISTS idx_videos_director;
    `)
    let columns = columnNames(database, 'videos')
    for (const column of ['maker', 'publisher', 'series', 'director']) {
      if (!columns.has(column)) continue
      database.exec(`ALTER TABLE videos DROP COLUMN ${column}`)
      columns = columnNames(database, 'videos')
    }
  }
  database.exec('DROP TABLE IF EXISTS facet_entries')
}

function migrateToV10(database: Database.Database): void {
  database.exec(PENDING_LOCAL_FILE_DELETIONS_SCHEMA_SQL)
}

type LegacyVideoIdentityRow = {
  id: number
  code: string | null
  publisher_organization_id: number | null
  release_date: string | null
}

function normalizedStoredVideoCode(code: string | null): string {
  if (code == null || !code.trim()) return ''
  return normalizeVideoCode(code)
}

function assertNoVideoBusinessIdentityConflicts(database: Database.Database): void {
  if (!tableExists(database, 'videos')) return
  const columns = columnNames(database, 'videos')
  if (
    !columns.has('code') ||
    !columns.has('publisher_organization_id') ||
    !columns.has('release_date')
  ) {
    return
  }
  const rows = database
    .prepare(
      `SELECT id, code, publisher_organization_id, release_date
       FROM videos
       WHERE publisher_organization_id IS NOT NULL
         AND code IS NOT NULL AND length(trim(code)) > 0
         AND release_date IS NOT NULL AND length(trim(release_date)) > 0
       ORDER BY id`
    )
    .all() as LegacyVideoIdentityRow[]
  const groups = new Map<string, number[]>()
  for (const row of rows) {
    const normalizedCode = normalizedStoredVideoCode(row.code)
    if (!normalizedCode || row.publisher_organization_id == null || !row.release_date?.trim()) {
      continue
    }
    const key = JSON.stringify([
      row.publisher_organization_id,
      normalizedCode,
      row.release_date.trim()
    ])
    const ids = groups.get(key)
    if (ids) ids.push(row.id)
    else groups.set(key, [row.id])
  }
  const conflicts = [...groups.values()].filter((ids) => ids.length > 1)
  if (conflicts.length === 0) return
  const details = conflicts.map((ids) => `影片 ID ${ids.join(', ')}`).join('；')
  throw new Error(`影片业务身份冲突，升级已取消：${details}`)
}

function rebuildVideosForBusinessIdentity(database: Database.Database): void {
  if (!tableExists(database, 'videos')) return
  const rows = database.prepare('SELECT * FROM videos ORDER BY id').all() as Array<
    Record<string, unknown> & { code: string | null }
  >
  database.exec(`
    PRAGMA defer_foreign_keys = ON;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE videos RENAME TO videos_v10;
    CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL DEFAULT '',
      title TEXT,
      summary TEXT,
      cover_path TEXT,
      poster_path TEXT,
      original_title TEXT,
      rating INTEGER DEFAULT 0,
      release_date TEXT,
      maker_organization_id INTEGER,
      publisher_organization_id INTEGER,
      series_id INTEGER,
      director_id INTEGER,
      duration_seconds INTEGER,
      scraped_status INTEGER DEFAULT 0,
      last_scraped_at TEXT,
      updated_at TEXT,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (maker_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
      FOREIGN KEY (publisher_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
      FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE SET NULL,
      FOREIGN KEY (director_id) REFERENCES directors(id) ON DELETE SET NULL
    );
  `)
  const insert = database.prepare(`
    INSERT INTO videos (
      id, code, title, summary, cover_path, poster_path, original_title, rating,
      release_date, maker_organization_id, publisher_organization_id, series_id,
      director_id, duration_seconds, scraped_status, last_scraped_at, updated_at, add_time
    ) VALUES (
      @id, @code, @title, @summary, @cover_path, @poster_path, @original_title, @rating,
      @release_date, @maker_organization_id, @publisher_organization_id, @series_id,
      @director_id, @duration_seconds, @scraped_status, @last_scraped_at, @updated_at, @add_time
    )
  `)
  for (const row of rows) {
    insert.run({
      id: row.id,
      code: normalizedStoredVideoCode(row.code),
      title: row.title ?? null,
      summary: row.summary ?? null,
      cover_path: row.cover_path ?? null,
      poster_path: row.poster_path ?? null,
      original_title: row.original_title ?? null,
      rating: row.rating ?? 0,
      release_date: row.release_date ?? null,
      maker_organization_id: row.maker_organization_id ?? null,
      publisher_organization_id: row.publisher_organization_id ?? null,
      series_id: row.series_id ?? null,
      director_id: row.director_id ?? null,
      duration_seconds: row.duration_seconds ?? null,
      scraped_status: row.scraped_status ?? 0,
      last_scraped_at: row.last_scraped_at ?? null,
      updated_at: row.updated_at ?? null,
      add_time: row.add_time ?? new Date(0).toISOString()
    })
  }
  database.exec(`
    DROP TABLE videos_v10;
    CREATE INDEX idx_videos_code ON videos(code);
    CREATE UNIQUE INDEX idx_videos_business_identity
      ON videos(publisher_organization_id, upper(trim(code)), release_date)
      WHERE publisher_organization_id IS NOT NULL
        AND code IS NOT NULL AND length(trim(code)) > 0
        AND release_date IS NOT NULL AND length(trim(release_date)) > 0;
    CREATE INDEX idx_videos_add_time ON videos(add_time);
    CREATE INDEX idx_videos_release_date ON videos(release_date);
    CREATE INDEX idx_videos_rating ON videos(rating);
    CREATE INDEX idx_videos_scraped_status ON videos(scraped_status);
    CREATE INDEX idx_videos_maker_organization_id ON videos(maker_organization_id);
    CREATE INDEX idx_videos_publisher_organization_id ON videos(publisher_organization_id);
    CREATE INDEX idx_videos_series_id ON videos(series_id);
    CREATE INDEX idx_videos_director_id ON videos(director_id);
    PRAGMA legacy_alter_table = OFF;
  `)
}

function migrateVideoSources(database: Database.Database): void {
  if (tableExists(database, 'video_external_ids')) {
    database.exec(`
      DROP INDEX IF EXISTS idx_video_external_source_id;
      DROP INDEX IF EXISTS idx_video_external_video_id;
      ALTER TABLE video_external_ids RENAME TO video_sources;
    `)
  }
  if (tableExists(database, 'video_sources')) {
    const columns = columnNames(database, 'video_sources')
    if (columns.has('external_id')) {
      database.exec('ALTER TABLE video_sources DROP COLUMN external_id')
    }
  }
  database.exec(VIDEO_SOURCES_SCHEMA_SQL)
}

function migrateToV11(database: Database.Database): void {
  assertNoVideoBusinessIdentityConflicts(database)
  try {
    rebuildVideosForBusinessIdentity(database)
    migrateVideoSources(database)
    database.exec(PENDING_VIDEO_DECISIONS_SCHEMA_SQL)
  } finally {
    database.pragma('legacy_alter_table = OFF')
  }
}

function migrateToV12(database: Database.Database): void {
  if (tableExists(database, 'video_resources')) {
    const resourceColumns = columnNames(database, 'video_resources')
    if (!resourceColumns.has('strm_source_path')) {
      database.exec('ALTER TABLE video_resources ADD COLUMN strm_source_path TEXT')
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_video_resources_strm_source_path
        ON video_resources(strm_source_path);
    `)
  }

  if (tableExists(database, 'pending_scan_resources')) {
    const pendingColumns = columnNames(database, 'pending_scan_resources')
    if (!pendingColumns.has('source_kind')) {
      database.exec(
        "ALTER TABLE pending_scan_resources ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'local' CHECK(source_kind IN ('local', 'strm'))"
      )
    }
    if (!pendingColumns.has('target_kind')) {
      database.exec(
        "ALTER TABLE pending_scan_resources ADD COLUMN target_kind TEXT CHECK(target_kind IN ('direct', 'web', 'magnet', 'ed2k'))"
      )
    }
    if (!pendingColumns.has('target_locator')) {
      database.exec('ALTER TABLE pending_scan_resources ADD COLUMN target_locator TEXT')
    }
    if (!pendingColumns.has('target_key')) {
      database.exec('ALTER TABLE pending_scan_resources ADD COLUMN target_key TEXT')
    }
  }
}

function migrateToV13(database: Database.Database): void {
  database.exec(RELATED_LINKS_SCHEMA_SQL)
}

type LegacyVideoResourceRow = {
  id: number
  video_id: number
  kind: 'local' | 'direct' | 'web' | 'magnet' | 'ed2k'
  locator: string
  resource_key: string
  strm_source_path: string | null
  size_bytes: number | null
  duration_seconds: number | null
  file_mtime_ms: number | null
  display_name: string | null
  is_primary: number
  add_time: string | null
}

type LegacyPendingScanGroupRow = {
  id: number
  normalized_code: string
  created_at: string
  updated_at: string
}

type LegacyPendingScanResourceRow = {
  id: number
  group_id: number
  file_path: string
  normalized_path: string
  scan_root: string
  source_kind: 'local' | 'strm'
  target_kind: 'direct' | 'web' | 'magnet' | 'ed2k' | null
  target_locator: string | null
  target_key: string | null
  size_bytes: number | null
  duration_seconds: number | null
  file_mtime_ms: number | null
  display_name: string | null
  created_at: string
  updated_at: string
}

function assertLegacyResourceIdentities(resources: LegacyVideoResourceRow[]): Map<number, string | null> {
  const identities = new Map<number, string | null>()
  const ownerByIdentity = new Map<string, number>()
  const primaryByVideo = new Map<number, number>()

  for (const resource of resources) {
    if (resource.kind === 'local' && resource.locator.trim().length === 0) {
      throw new Error(`Cannot migrate local video resource ${resource.id}: locator is empty.`)
    }
    if (resource.strm_source_path !== null && resource.strm_source_path.trim().length === 0) {
      throw new Error(`Cannot migrate STRM video resource ${resource.id}: source path is empty.`)
    }
    const identity = buildVideoResourceSourceIdentity({
      kind: resource.kind,
      locator: resource.locator,
      strmSourcePath: resource.strm_source_path
    })
    identities.set(resource.id, identity)
    if (identity) {
      const existingId = ownerByIdentity.get(identity)
      if (existingId !== undefined) {
        throw new Error(
          `Cannot migrate video resources ${existingId} and ${resource.id}: both resolve to source identity ${identity}. Remove the duplicate source before retrying.`
        )
      }
      ownerByIdentity.set(identity, resource.id)
    }
    if (resource.is_primary === 1) {
      const existingPrimary = primaryByVideo.get(resource.video_id)
      if (existingPrimary !== undefined) {
        throw new Error(
          `Cannot migrate video ${resource.video_id}: resources ${existingPrimary} and ${resource.id} are both primary.`
        )
      }
      primaryByVideo.set(resource.video_id, resource.id)
    }
  }
  return identities
}

function createLegacyPendingRoots(
  database: Database.Database,
  resources: LegacyPendingScanResourceRow[]
): Map<string, number> {
  const rootIdByIdentity = new Map<string, number>()
  const insertRoot = database.prepare(`
    INSERT OR IGNORE INTO media_library_roots (
      library_id, path, normalized_path, position, state
    ) VALUES (1, ?, ?, ?, 'disabled')
  `)
  const getRoot = database.prepare(
    'SELECT id FROM media_library_roots WHERE normalized_path = ?'
  )

  for (const resource of resources) {
    const path = resource.scan_root.trim()
    if (!path) {
      throw new Error(`Cannot migrate pending scan resource ${resource.id}: scan root is empty.`)
    }
    const identity = normalizeLocalPathIdentity(path)
    if (rootIdByIdentity.has(identity)) continue
    insertRoot.run(path, identity, rootIdByIdentity.size)
    const row = getRoot.get(identity) as { id: number } | undefined
    if (!row) {
      throw new Error(`Cannot migrate pending scan root ${path}: root record was not created.`)
    }
    rootIdByIdentity.set(identity, row.id)
  }
  return rootIdByIdentity
}

function rebuildVideoResourcesForLibraries(
  database: Database.Database,
  resources: LegacyVideoResourceRow[],
  sourceIdentityById: Map<number, string | null>
): void {
  if (!tableExists(database, 'video_resources')) {
    database.exec(MEDIA_LIBRARY_VIDEO_RESOURCES_SCHEMA_SQL)
    return
  }
  database.exec(`
    DROP INDEX IF EXISTS idx_video_resources_video_id;
    DROP INDEX IF EXISTS idx_video_resources_key;
    DROP INDEX IF EXISTS idx_video_resources_primary;
    DROP INDEX IF EXISTS idx_video_resources_kind;
    DROP INDEX IF EXISTS idx_video_resources_strm_source_path;
    ALTER TABLE video_resources RENAME TO video_resources_v13;
  `)
  database.exec(MEDIA_LIBRARY_VIDEO_RESOURCES_SCHEMA_SQL)
  const insertResource = database.prepare(`
    INSERT INTO video_resources (
      id, library_id, video_id, root_id, kind, locator, resource_key,
      source_identity, strm_source_path, size_bytes, duration_seconds,
      file_mtime_ms, display_name, is_primary, add_time
    ) VALUES (
      @id, 1, @videoId, NULL, @kind, @locator, @resourceKey,
      @sourceIdentity, @strmSourcePath, @sizeBytes, @durationSeconds,
      @fileMtimeMs, @displayName, @isPrimary, @addTime
    )
  `)
  for (const resource of resources) {
    insertResource.run({
      id: resource.id,
      videoId: resource.video_id,
      kind: resource.kind,
      locator: resource.locator,
      resourceKey: resource.resource_key,
      sourceIdentity: sourceIdentityById.get(resource.id) ?? null,
      strmSourcePath: resource.strm_source_path,
      sizeBytes: resource.size_bytes,
      durationSeconds: resource.duration_seconds,
      fileMtimeMs: resource.file_mtime_ms,
      displayName: resource.display_name,
      isPrimary: resource.is_primary,
      addTime: resource.add_time
    })
  }
  database.exec('DROP TABLE video_resources_v13')
}

function rebuildPendingScanForLibraries(
  database: Database.Database,
  groups: LegacyPendingScanGroupRow[],
  resources: LegacyPendingScanResourceRow[],
  rootIdByIdentity: Map<string, number>
): void {
  database.exec(`
    DROP INDEX IF EXISTS idx_pending_scan_resources_group;
    DROP INDEX IF EXISTS idx_pending_scan_resources_root;
    DROP INDEX IF EXISTS idx_pending_scan_groups_updated_at;
    DROP TABLE IF EXISTS pending_scan_resources;
    DROP TABLE IF EXISTS pending_scan_groups;
  `)
  database.exec(MEDIA_LIBRARY_PENDING_SCAN_SCHEMA_SQL)

  const insertGroup = database.prepare(`
    INSERT INTO pending_scan_groups (
      id, library_id, normalized_code, revision, created_at, updated_at
    ) VALUES (@id, 1, @normalizedCode, 1, @createdAt, @updatedAt)
  `)
  for (const group of groups) {
    insertGroup.run({
      id: group.id,
      normalizedCode: group.normalized_code,
      createdAt: group.created_at,
      updatedAt: group.updated_at
    })
  }

  const insertResource = database.prepare(`
    INSERT INTO pending_scan_resources (
      id, library_id, group_id, root_id, file_path, normalized_path,
      source_kind, target_kind, target_locator, target_key, size_bytes,
      duration_seconds, file_mtime_ms, display_name, created_at, updated_at
    ) VALUES (
      @id, 1, @groupId, @rootId, @filePath, @normalizedPath,
      @sourceKind, @targetKind, @targetLocator, @targetKey, @sizeBytes,
      @durationSeconds, @fileMtimeMs, @displayName, @createdAt, @updatedAt
    )
  `)
  for (const resource of resources) {
    const rootId = rootIdByIdentity.get(normalizeLocalPathIdentity(resource.scan_root.trim()))
    if (rootId === undefined) {
      throw new Error(
        `Cannot migrate pending scan resource ${resource.id}: its root was not created.`
      )
    }
    insertResource.run({
      id: resource.id,
      groupId: resource.group_id,
      rootId,
      filePath: resource.file_path,
      normalizedPath: resource.normalized_path,
      sourceKind: resource.source_kind,
      targetKind: resource.target_kind,
      targetLocator: resource.target_locator,
      targetKey: resource.target_key,
      sizeBytes: resource.size_bytes,
      durationSeconds: resource.duration_seconds,
      fileMtimeMs: resource.file_mtime_ms,
      displayName: resource.display_name,
      createdAt: resource.created_at,
      updatedAt: resource.updated_at
    })
  }
}

/** Single 0.6.0 migration from the released V13 schema; do not model unreleased intermediates. */
function migrateToV14(database: Database.Database): void {
  database.exec(AGENT_PLATFORM_SCHEMA_SQL)
  database.exec(AGENT_METADATA_SCHEMA_SQL)

  const hasVideos = tableExists(database, 'videos')
  const hasResources = tableExists(database, 'video_resources')
  const hasPendingGroups = tableExists(database, 'pending_scan_groups')
  const hasPendingResources = tableExists(database, 'pending_scan_resources')
  const videoCount = hasVideos
    ? Number(
        (database.prepare('SELECT COUNT(*) AS count FROM videos').get() as { count: number }).count
      )
    : 0
  const resources = hasResources
    ? (database
        .prepare('SELECT * FROM video_resources ORDER BY id')
        .all() as LegacyVideoResourceRow[])
    : []
  const groups = hasPendingGroups
    ? (database
        .prepare('SELECT * FROM pending_scan_groups ORDER BY id')
        .all() as LegacyPendingScanGroupRow[])
    : []
  const pendingResources = hasPendingResources
    ? (database
        .prepare('SELECT * FROM pending_scan_resources ORDER BY id')
        .all() as LegacyPendingScanResourceRow[])
    : []
  const sourceIdentityById = assertLegacyResourceIdentities(resources)

  database.exec(MEDIA_LIBRARY_CORE_SCHEMA_SQL)
  const rootIdByIdentity = createLegacyPendingRoots(database, pendingResources)
  database.exec(MEDIA_LIBRARY_MEMBERSHIP_SCHEMA_SQL)
  if (hasVideos) {
    const videoColumns = columnNames(database, 'videos')
    const addedAt = videoColumns.has('add_time')
      ? 'COALESCE(add_time, CURRENT_TIMESTAMP)'
      : 'CURRENT_TIMESTAMP'
    const updatedAt = videoColumns.has('updated_at')
      ? videoColumns.has('add_time')
        ? 'COALESCE(updated_at, add_time, CURRENT_TIMESTAMP)'
        : 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
      : addedAt
    database.exec(`
      INSERT OR IGNORE INTO library_video_memberships (
        library_id, video_id, added_at, updated_at, added_via,
        is_pinned, is_hidden, discovery_key
      )
      SELECT
        1,
        id,
        ${addedAt},
        ${updatedAt},
        'shared',
        0,
        0,
        ((id * 1103515245 + 12345) & 2147483647)
      FROM videos
    `)
  }
  rebuildVideoResourcesForLibraries(database, resources, sourceIdentityById)
  rebuildPendingScanForLibraries(database, groups, pendingResources, rootIdByIdentity)
  database.exec(MEDIA_LIBRARY_SCAN_SCHEMA_SQL)
  normalizeStoredRelatedLinks(database)

  const migratedVideoCount = hasVideos
    ? Number(
        (
          database
            .prepare(
              'SELECT COUNT(*) AS count FROM library_video_memberships WHERE library_id = 1'
            )
            .get() as { count: number }
        ).count
      )
    : 0
  const migratedResourceCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM video_resources').get() as { count: number })
      .count
  )
  const migratedGroupCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM pending_scan_groups').get() as {
      count: number
    }).count
  )
  const migratedPendingResourceCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM pending_scan_resources').get() as {
      count: number
    }).count
  )
  if (
    migratedVideoCount !== videoCount ||
    migratedResourceCount !== resources.length ||
    migratedGroupCount !== groups.length ||
    migratedPendingResourceCount !== pendingResources.length
  ) {
    throw new Error(
      'Multi-library migration count check failed; the migration was rolled back without changing the database.'
    )
  }
}

function migrateToV15(database: Database.Database): void {
  const existing = (
    database.prepare('PRAGMA table_info(media_library_configs)').all() as Array<{
      name: string
      type: string
      notnull: 0 | 1
      dflt_value: string | null
    }>
  ).find((column) => column.name === 'auto_import_local_nfo')
  if (existing) {
    if (
      existing.type.toUpperCase() !== 'INTEGER' ||
      existing.notnull !== 1 ||
      existing.dflt_value !== '1'
    ) {
      throw new Error('duplicate column name: auto_import_local_nfo')
    }
  } else {
    database.exec(`
      ALTER TABLE media_library_configs
        ADD COLUMN auto_import_local_nfo INTEGER NOT NULL DEFAULT 1
        CHECK(auto_import_local_nfo IN (0, 1));
    `)
  }
  database.exec(PENDING_RESOURCE_IDENTITIES_SCHEMA_SQL)
}

function normalizeStoredRelatedLinks(database: Database.Database): void {
  for (const [table, entityColumn] of [
    ['organization_links', 'organization_id'],
    ['director_links', 'director_id'],
    ['series_links', 'series_id'],
    ['video_links', 'video_id'],
    ['actress_links', 'actress_id'],
    ['playlist_links', 'playlist_id']
  ] as const) {
    if (!tableExists(database, table)) continue
    const rows = database.prepare(
      `SELECT id, ${entityColumn} AS entity_id, url, position FROM ${table} ORDER BY position, id`
    ).all() as Array<{ id: number; entity_id: number; url: string; position: number }>
    const retained = new Map<string, { id: number; url: string; normalizedUrl: string }>()
    for (const row of rows) {
      let storedUrl = row.url
      let normalizedUrl: string
      try {
        normalizedUrl = normalizeRelatedLinkUrl(storedUrl)
      } catch (error) {
        const parsed = new URL(storedUrl.trim())
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          (!parsed.username && !parsed.password)
        ) {
          throw error
        }
        // V13 accepted credential-bearing HTTP links. Remove the credentials during
        // the V14 upgrade so a released database remains openable and no secret is retained.
        parsed.username = ''
        parsed.password = ''
        storedUrl = parsed.toString()
        normalizedUrl = normalizeRelatedLinkUrl(storedUrl)
      }
      const key = `${row.entity_id}:${normalizedUrl}`
      if (retained.has(key)) {
        database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id)
      } else {
        retained.set(key, { id: row.id, url: storedUrl, normalizedUrl })
      }
    }
    const update = database.prepare(`UPDATE ${table} SET url = ?, normalized_url = ? WHERE id = ?`)
    for (const row of retained.values()) update.run(row.url, row.normalizedUrl, row.id)
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    migrate: migrateToV2
  },
  {
    version: 3,
    migrate: migrateToV3
  },
  {
    version: 4,
    migrate: migrateToV4
  },
  {
    version: 5,
    migrate: migrateToV5
  },
  {
    version: 6,
    migrate: migrateToV6
  },
  {
    version: 7,
    migrate: migrateToV7
  },
  {
    version: 8,
    migrate: migrateToV8
  },
  {
    version: 9,
    migrate: migrateToV9
  },
  {
    version: 10,
    migrate: migrateToV10
  },
  {
    version: 11,
    migrate: migrateToV11
  },
  {
    version: 12,
    migrate: migrateToV12
  },
  {
    version: 13,
    migrate: migrateToV13
  },
  {
    version: 14,
    migrate: migrateToV14
  },
  {
    version: 15,
    migrate: migrateToV15
  },
  {
    version: 16,
    migrate: (database) => database.exec(AGENT_RESOURCE_CLEANUP_SCHEMA_SQL)
  },
  {
    version: 17,
    migrate: (database) => {
      // Keep the tag-key contract while covering manual-origin qualification.
      // The enclosing migration transaction rolls back both DDL and version.
      database.exec('DROP INDEX idx_video_tag_tag_id')
      database.exec('CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id,origin)')
    }
  },
  {
    version: 18,
    migrate: (database) => database.exec(SCAN_AUDIT_ENTRIES_V18_SCHEMA_SQL)
  }
]

function migrationForVersion(version: number): Migration | undefined {
  return MIGRATIONS.find((migration) => migration.version === version)
}

/** Initialise or upgrade the database schema. */
export function migrateDatabase(database: Database.Database): void {
  const current = Number(database.pragma('user_version', { simple: true }) ?? 0)
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is no longer supported. Delete the database file and restart.`
    )
  }
  if (current === 0) {
    database.transaction(() => {
      database.exec(SCHEMA_SQL)
      database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
    })()
    return
  }
  const foreignKeysEnabled = Number(database.pragma('foreign_keys', { simple: true })) === 1
  if (foreignKeysEnabled) database.pragma('foreign_keys = OFF')
  try {
    database.transaction(() => {
      for (let next = current + 1; next <= CURRENT_SCHEMA_VERSION; next += 1) {
        const migration = migrationForVersion(next)
        if (!migration) {
          throw new Error(`Missing database migration for schema version ${next}.`)
        }
        migration.migrate(database)
        database.pragma(`user_version = ${next}`)
      }
      const foreignKeyViolations = database.pragma('foreign_key_check') as Array<{
        table: string
        rowid: number | null
        parent: string
      }>
      if (foreignKeyViolations.length > 0) {
        const first = foreignKeyViolations[0]
        throw new Error(
          `FOREIGN KEY constraint failed during migration: ${first.table} row ${first.rowid ?? '?'} -> ${first.parent}`
        )
      }
    })()
  } finally {
    if (foreignKeysEnabled) database.pragma('foreign_keys = ON')
  }
}
