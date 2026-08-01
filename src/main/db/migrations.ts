import type Database from 'better-sqlite3'
import { normalizeActressName } from './actressNameOwnership'
import { SCHEMA_SQL } from './schema'

export const CURRENT_SCHEMA_VERSION = 5

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
  for (let next = current + 1; next <= CURRENT_SCHEMA_VERSION; next += 1) {
    const migration = migrationForVersion(next)
    if (!migration) {
      throw new Error(`Missing database migration for schema version ${next}.`)
    }
    database.transaction(() => {
      migration.migrate(database)
      database.pragma(`user_version = ${next}`)
    })()
  }
}
