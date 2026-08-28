import type Database from 'better-sqlite3'
import type {
  AgentMetadataApplyOutcome,
  AgentMetadataDraft,
  AgentMetadataDraftPayload,
  AgentMetadataDraftResource,
  AgentMetadataReview,
  AgentMetadataSource,
  AgentMetadataTarget
} from '@shared/agentMetadataTypes'
import { getDb } from './database'

interface DraftRow {
  id: string
  run_id: string | null
  entity_kind: AgentMetadataTarget['kind']
  entity_id: number
  adapter_schema_version: number
  status: AgentMetadataDraft['status']
  revision: number
  requested_url: string
  resolved_url: string | null
  display_url: string
  source_name: string | null
  page_title: string | null
  payload_json: string
  warnings_json: string
  review_json: string | null
  review_token: string | null
  apply_idempotency_key: string | null
  outcome_json: string | null
  created_at: string
  updated_at: string
}

interface ResourceRow {
  field: AgentMetadataDraftResource['field']
  position: number
  remote_url: string | null
  staged_path: string
  width: number | null
  height: number | null
  size_bytes: number
  sha256: string
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(`Agent 元数据草稿的 ${label} 已损坏。`)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export class AgentMetadataDraftRepo {
  constructor(private readonly database: () => Database.Database = getDb) {}

  create(input: {
    id: string
    runId: string
    target: AgentMetadataTarget
    source: AgentMetadataSource
    payload: AgentMetadataDraftPayload
    resources: AgentMetadataDraftResource[]
    warnings: string[]
  }): { draft: AgentMetadataDraft; supersededStagedPaths: string[] } {
    const db = this.database()
    return db.transaction(() => {
      const superseded = db
        .prepare(
          `SELECT r.staged_path
             FROM agent_metadata_draft_resources r
             JOIN agent_metadata_drafts d ON d.id = r.draft_id
            WHERE d.entity_kind = ? AND d.entity_id = ? AND d.status = 'ready'`
        )
        .all(input.target.kind, input.target.id) as Array<{ staged_path: string }>

      db.prepare(
        `UPDATE agent_metadata_drafts
            SET status = 'discarded', revision = revision + 1, updated_at = ?
          WHERE entity_kind = ? AND entity_id = ? AND status = 'ready'`
      ).run(nowIso(), input.target.kind, input.target.id)

      const createdAt = nowIso()
      db.prepare(
        `INSERT INTO agent_metadata_drafts (
           id, run_id, entity_kind, entity_id, adapter_schema_version, status, revision,
           requested_url, resolved_url, display_url, source_name, page_title,
           payload_json, warnings_json, created_at, updated_at
         ) VALUES (
           @id, @runId, @entityKind, @entityId, 1, 'ready', 1,
           @requestedUrl, @resolvedUrl, @displayUrl, @sourceName, @pageTitle,
           @payloadJson, @warningsJson, @createdAt, @createdAt
         )`
      ).run({
        id: input.id,
        runId: input.runId,
        entityKind: input.target.kind,
        entityId: input.target.id,
        requestedUrl: input.source.requestedUrl,
        resolvedUrl: input.source.finalUrl ?? null,
        displayUrl: input.source.displayUrl,
        sourceName: input.source.sourceName ?? null,
        pageTitle: input.source.pageTitle ?? null,
        payloadJson: JSON.stringify(input.payload),
        warningsJson: JSON.stringify(input.warnings),
        createdAt
      })

      const insertResource = db.prepare(
        `INSERT INTO agent_metadata_draft_resources (
           draft_id, field, position, remote_url, staged_path, width, height, size_bytes, sha256
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const resource of input.resources) {
        insertResource.run(
          input.id,
          resource.field,
          resource.position,
          resource.remoteUrl,
          resource.stagedPath,
          resource.width,
          resource.height,
          resource.sizeBytes,
          resource.sha256
        )
      }

      return {
        draft: this.require(input.id),
        supersededStagedPaths: superseded.map((item) => item.staged_path)
      }
    })()
  }

  get(draftId: string): AgentMetadataDraft | null {
    const row = this.database()
      .prepare('SELECT * FROM agent_metadata_drafts WHERE id = ?')
      .get(draftId) as DraftRow | undefined
    return row ? this.hydrate(row) : null
  }

  require(draftId: string): AgentMetadataDraft {
    const draft = this.get(draftId)
    if (!draft) throw new Error('Agent 元数据草稿不存在。')
    return draft
  }

  findReadyForTarget(target: AgentMetadataTarget): AgentMetadataDraft | null {
    const row = this.database()
      .prepare(
        `SELECT * FROM agent_metadata_drafts
          WHERE entity_kind = ? AND entity_id = ? AND status = 'ready'
          ORDER BY updated_at DESC LIMIT 1`
      )
      .get(target.kind, target.id) as DraftRow | undefined
    return row ? this.hydrate(row) : null
  }

  findByRunId(runId: string): AgentMetadataDraft | null {
    const row = this.database()
      .prepare(
        `SELECT * FROM agent_metadata_drafts WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1`
      )
      .get(runId) as DraftRow | undefined
    return row ? this.hydrate(row) : null
  }

  saveReview(input: {
    draftId: string
    expectedRevision: number
    review: AgentMetadataReview
  }): AgentMetadataReview {
    const nextRevision = input.expectedRevision + 1
    if (input.review.draftId !== input.draftId || input.review.revision !== nextRevision) {
      throw new Error('Agent 元数据预览版本无效。')
    }
    const info = this.database()
      .prepare(
        `UPDATE agent_metadata_drafts
            SET revision = ?, review_json = ?, review_token = ?, updated_at = ?
          WHERE id = ? AND status = 'ready' AND revision = ?`
      )
      .run(
        nextRevision,
        JSON.stringify(input.review),
        input.review.token,
        nowIso(),
        input.draftId,
        input.expectedRevision
      )
    if (info.changes !== 1) throw new Error('草稿已更新，请重新检查预览。')
    return input.review
  }

  getStoredReview(draftId: string): AgentMetadataReview | null {
    const row = this.database()
      .prepare('SELECT review_json FROM agent_metadata_drafts WHERE id = ?')
      .get(draftId) as { review_json: string | null } | undefined
    return row?.review_json ? parseJson<AgentMetadataReview>(row.review_json, 'review_json') : null
  }

  getStoredOutcome(input: {
    draftId: string
    idempotencyKey: string
  }): AgentMetadataApplyOutcome | null {
    const row = this.database()
      .prepare(
        `SELECT apply_idempotency_key, outcome_json
           FROM agent_metadata_drafts WHERE id = ?`
      )
      .get(input.draftId) as
      | { apply_idempotency_key: string | null; outcome_json: string | null }
      | undefined
    if (!row || row.apply_idempotency_key !== input.idempotencyKey || !row.outcome_json) return null
    return parseJson<AgentMetadataApplyOutcome>(row.outcome_json, 'outcome_json')
  }

  completeApply(input: {
    draftId: string
    reviewToken: string
    idempotencyKey: string
    outcome: AgentMetadataApplyOutcome
  }): void {
    const terminalStatus =
      input.outcome.status === 'routed_to_pending' ? 'routed_to_pending' : 'applied'
    const info = this.database()
      .prepare(
        `UPDATE agent_metadata_drafts
            SET status = ?, revision = revision + 1, apply_idempotency_key = ?,
                outcome_json = ?, updated_at = ?, applied_at = ?
          WHERE id = ? AND status = 'ready' AND review_token = ?`
      )
      .run(
        terminalStatus,
        input.idempotencyKey,
        JSON.stringify(input.outcome),
        nowIso(),
        nowIso(),
        input.draftId,
        input.reviewToken
      )
    if (info.changes !== 1) throw new Error('预览已过期，请重新检查后再应用。')
  }

  discard(input: {
    draftId: string
    expectedRevision: number
  }): { stagedPaths: string[] } {
    const db = this.database()
    return db.transaction(() => {
      const resources = db
        .prepare('SELECT staged_path FROM agent_metadata_draft_resources WHERE draft_id = ?')
        .all(input.draftId) as Array<{ staged_path: string }>
      const info = db
        .prepare(
          `UPDATE agent_metadata_drafts
              SET status = 'discarded', revision = revision + 1, updated_at = ?
            WHERE id = ? AND status = 'ready' AND revision = ?`
        )
        .run(nowIso(), input.draftId, input.expectedRevision)
      if (info.changes !== 1) throw new Error('草稿已更新，无法按旧版本丢弃。')
      return { stagedPaths: resources.map((item) => item.staged_path) }
    })()
  }

  private hydrate(row: DraftRow): AgentMetadataDraft {
    if (row.adapter_schema_version !== 1) {
      throw new Error(`Agent 元数据草稿适配器版本不兼容：${row.adapter_schema_version}`)
    }
    const resourceRows = this.database()
      .prepare(
        `SELECT field, position, remote_url, staged_path, width, height, size_bytes, sha256
           FROM agent_metadata_draft_resources
          WHERE draft_id = ? ORDER BY field, position`
      )
      .all(row.id) as ResourceRow[]
    return {
      id: row.id,
      runId: row.run_id,
      target: { kind: row.entity_kind, id: row.entity_id } as AgentMetadataTarget,
      revision: row.revision,
      status: row.status,
      source: {
        requestedUrl: row.requested_url,
        finalUrl: row.resolved_url ?? undefined,
        displayUrl: row.display_url,
        sourceName: row.source_name ?? undefined,
        pageTitle: row.page_title ?? undefined
      },
      payload: parseJson<AgentMetadataDraftPayload>(row.payload_json, 'payload_json'),
      resources: resourceRows.map((resource) => ({
        field: resource.field,
        position: resource.position,
        remoteUrl: resource.remote_url,
        stagedPath: resource.staged_path,
        width: resource.width,
        height: resource.height,
        sizeBytes: resource.size_bytes,
        sha256: resource.sha256
      })),
      warnings: parseJson<string[]>(row.warnings_json, 'warnings_json'),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}

export const agentMetadataDraftRepo = new AgentMetadataDraftRepo()
