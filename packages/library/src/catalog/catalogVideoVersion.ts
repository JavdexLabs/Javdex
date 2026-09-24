import type Database from 'better-sqlite3'
import type { AggregateVersion, ExpectedVersions } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'

export function readVideoAggregateVersion(
  videoId: number,
  database: Database.Database = getDb()
): AggregateVersion | null {
  const row = database
    .prepare('SELECT generation, revision FROM videos WHERE id = ?')
    .get(videoId) as AggregateVersion | undefined
  return row ?? null
}

export function assertExpectedVideoVersion(
  videoId: number,
  expected: ExpectedVersions,
  operationId?: string,
  database: Database.Database = getDb()
): AggregateVersion {
  if (!expected.V) {
    throw structuredError(
      'INVALID_INPUT',
      '影片编辑需要 V 版本',
      { field: 'expectedVersions.V', entityKind: 'video', entityId: videoId },
      operationId
    )
  }
  const current = readVideoAggregateVersion(videoId, database)
  if (!current) {
    throw structuredError(
      'INVALID_INPUT',
      '影片不存在',
      { entityKind: 'video', entityId: videoId },
      operationId
    )
  }
  if (current.generation !== expected.V.generation || current.revision !== expected.V.revision) {
    throw structuredError(
      'VERSION_CONFLICT',
      '影片资料已更新，请刷新后重新确认',
      { entityKind: 'video', entityId: videoId },
      operationId
    )
  }
  return current
}
