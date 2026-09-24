import type Database from 'better-sqlite3'
import type { AggregateVersion, ExpectedVersions, VersionScope } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import {
  assertExpectedVideoVersion,
  readVideoAggregateVersion
} from './catalogVideoVersion'

export { assertExpectedVideoVersion, readVideoAggregateVersion }

const SCOPE_LABEL: Record<'A' | 'F' | 'P', { missing: string; gone: string; conflict: string; kind: string }> = {
  A: {
    missing: '演员资料需要 A 版本',
    gone: '演员不存在',
    conflict: '演员资料已更新，请刷新后重新确认',
    kind: 'actress'
  },
  F: {
    missing: '分类资料需要 F 版本',
    gone: '分类实体不存在',
    conflict: '分类资料已更新，请刷新后重新确认',
    kind: 'classification'
  },
  P: {
    missing: '清单资料需要 P 版本',
    gone: '清单不存在',
    conflict: '清单资料已更新，请刷新后重新确认',
    kind: 'playlist'
  }
}

function readRow(
  sql: string,
  id: number,
  database: Database.Database
): AggregateVersion | null {
  const row = database.prepare(sql).get(id) as AggregateVersion | undefined
  return row ?? null
}

export function readActressAggregateVersion(
  actressId: number,
  database: Database.Database = getDb()
): AggregateVersion | null {
  return readRow('SELECT generation, revision FROM actresses WHERE id = ?', actressId, database)
}

export function readPlaylistAggregateVersion(
  playlistId: number,
  database: Database.Database = getDb()
): AggregateVersion | null {
  return readRow('SELECT generation, revision FROM playlists WHERE id = ?', playlistId, database)
}

export function readClassificationAggregateVersion(
  kind: 'organization' | 'director' | 'series',
  id: number,
  database: Database.Database = getDb()
): AggregateVersion | null {
  const table =
    kind === 'organization' ? 'organizations' : kind === 'director' ? 'directors' : 'series'
  return readRow(`SELECT generation, revision FROM ${table} WHERE id = ?`, id, database)
}

function assertScope(
  scope: 'A' | 'F' | 'P',
  expected: ExpectedVersions,
  current: AggregateVersion | null,
  entityId: number,
  operationId?: string
): AggregateVersion {
  const label = SCOPE_LABEL[scope]
  const wanted = expected[scope]
  if (!wanted) {
    throw structuredError(
      'INVALID_INPUT',
      label.missing,
      { field: `expectedVersions.${scope}`, entityKind: label.kind, entityId },
      operationId
    )
  }
  if (!current) {
    throw structuredError(
      'INVALID_INPUT',
      label.gone,
      { entityKind: label.kind, entityId },
      operationId
    )
  }
  if (current.generation !== wanted.generation || current.revision !== wanted.revision) {
    throw structuredError('VERSION_CONFLICT', label.conflict, {
      entityKind: label.kind,
      entityId
    }, operationId)
  }
  return current
}

export function assertExpectedActressVersion(
  actressId: number,
  expected: ExpectedVersions,
  operationId?: string,
  database: Database.Database = getDb()
): AggregateVersion {
  return assertScope('A', expected, readActressAggregateVersion(actressId, database), actressId, operationId)
}

export function assertExpectedPlaylistVersion(
  playlistId: number,
  expected: ExpectedVersions,
  operationId?: string,
  database: Database.Database = getDb()
): AggregateVersion {
  return assertScope('P', expected, readPlaylistAggregateVersion(playlistId, database), playlistId, operationId)
}

export function assertExpectedClassificationVersion(
  kind: 'organization' | 'director' | 'series',
  id: number,
  expected: ExpectedVersions,
  operationId?: string,
  database: Database.Database = getDb()
): AggregateVersion {
  return assertScope('F', expected, readClassificationAggregateVersion(kind, id, database), id, operationId)
}

export function bumpRowRevision(
  table: string,
  id: number,
  database: Database.Database = getDb()
): AggregateVersion {
  database
    .prepare(`UPDATE ${table} SET updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(new Date().toISOString(), id)
  const row = database
    .prepare(`SELECT generation, revision FROM ${table} WHERE id = ?`)
    .get(id) as AggregateVersion | undefined
  if (!row) throw structuredError('INVALID_INPUT', '对象不存在', { entityId: id })
  return row
}

export function requiredScope(scope: VersionScope, expected: ExpectedVersions, operationId?: string): void {
  if (!expected[scope]) {
    throw structuredError(
      'INVALID_INPUT',
      `缺少 ${scope} 版本`,
      { field: `expectedVersions.${scope}` },
      operationId
    )
  }
}
