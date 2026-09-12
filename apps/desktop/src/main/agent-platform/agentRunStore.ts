import { safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db/database'
import type {
  ExecutionHistoryFrame,
  OpaqueRuntimeSessionRef,
  ResolvedRunConfiguration,
  RuntimeDurableObservation,
  RuntimeRecoveryFrame,
  PersistedRunConfigurationSnapshot
} from './types'

export type AgentRunStatus =
  | 'created'
  | 'running'
  | 'waiting_user'
  | 'settled'
  | 'failed'
  | 'cancelled'
  | 'recovering'
  | 'closed'

export interface AgentRunRecord<ProductState = Record<string, unknown>> {
  id: string
  useCase: string
  status: AgentRunStatus
  activeOperationId?: string
  configRevision: string
  configSnapshot: PersistedRunConfigurationSnapshot
  runtimeSessionRef?: OpaqueRuntimeSessionRef
  recoveryGeneration: number
  productState: ProductState
  createdAt: string
  updatedAt: string
  closedAt?: string
}

export interface AgentJournalRecord<Event = Record<string, unknown>> {
  seq: number
  runId: string
  operationId?: string
  eventType: string
  payload: Event
  createdAt: string
}

export interface AgentOperationRecord {
  id: string
  runId: string
  commandKind: 'prompt' | 'steer' | 'follow-up' | 'compact' | 'abort'
  idempotencyKey: string
  contentHash: string
  status: 'accepted' | 'settled' | 'rejected' | 'failed'
  createdAt: string
  settledAt?: string
  error?: string
}

export interface AgentArtifactRecord<Ref = Record<string, unknown>> {
  id: string
  runId: string
  kind: string
  label: string
  ref: Ref
  contentHash: string
  createdAt: string
}

export interface AgentPayloadCipher {
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

let cipherOverride: AgentPayloadCipher | null = null

function activeCipher(): AgentPayloadCipher {
  if (cipherOverride) return cipherOverride
  return {
    encrypt(value): Buffer {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('ExecutionHistory 安全存储不可用')
      return safeStorage.encryptString(value)
    },
    decrypt(value): string {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('ExecutionHistory 安全存储不可用')
      return safeStorage.decryptString(value)
    }
  }
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T
}

function now(): string {
  return new Date().toISOString()
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface RunRow {
  id: string
  use_case: string
  status: AgentRunStatus
  active_operation_id: string | null
  config_revision: string
  config_snapshot_json: string
  runtime_session_ref_json: string | null
  recovery_generation: number
  recovery_attempted_generation: number
  product_state_json: string
  created_at: string
  updated_at: string
  closed_at: string | null
}

function toRun<ProductState>(row: RunRow): AgentRunRecord<ProductState> {
  return {
    id: row.id,
    useCase: row.use_case,
    status: row.status,
    activeOperationId: row.active_operation_id ?? undefined,
    configRevision: row.config_revision,
    configSnapshot: parse(row.config_snapshot_json),
    runtimeSessionRef: row.runtime_session_ref_json ? parse(row.runtime_session_ref_json) : undefined,
    recoveryGeneration: row.recovery_generation,
    productState: parse(row.product_state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined
  }
}

export class AgentRunStore {
  constructor(private readonly database: () => Database.Database = getDb) {}

  createRun<ProductState>(input: {
    runId?: string
    useCase: string
    resolved: ResolvedRunConfiguration
    productState: ProductState
  }): AgentRunRecord<ProductState> {
    const runId = input.runId ?? randomUUID()
    const at = now()
    const configSnapshot = {
      revision: input.resolved.revision,
      definitionId: input.resolved.definitionId,
      profile: input.resolved.profile,
      model: {
        credentialRef: input.resolved.model.credentialRef,
        descriptor: input.resolved.model.model,
        routeRevision: input.resolved.model.routeRevision,
        preset: input.resolved.model.preset,
        cacheCompatibility: input.resolved.model.cacheCompatibility
      },
      verifierModel: input.resolved.verifierModel
        ? {
            credentialRef: input.resolved.verifierModel.credentialRef,
            descriptor: input.resolved.verifierModel.model,
            routeRevision: input.resolved.verifierModel.routeRevision,
            preset: input.resolved.verifierModel.preset,
            cacheCompatibility: input.resolved.verifierModel.cacheCompatibility
          }
        : undefined,
      cache: input.resolved.cache,
      systemPrompt: input.resolved.systemPrompt,
      tools: input.resolved.tools.map(({ invoke: _invoke, ...tool }) => tool),
      settings: input.resolved.settings,
      resources: input.resolved.resources
    }
    this.database().prepare(`
      INSERT INTO agent_runs (
        id, use_case, status, config_revision, config_snapshot_json, runtime_id,
        product_state_json, created_at, updated_at
      ) VALUES (?, ?, 'created', ?, ?, 'pi', ?, ?, ?)
    `).run(runId, input.useCase, input.resolved.revision, json(configSnapshot), json(input.productState), at, at)
    return this.getRun<ProductState>(runId)!
  }

  getRunStatus(runId: string): AgentRunStatus | null {
    const row = this.database().prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as { status: AgentRunStatus } | undefined
    return row?.status ?? null
  }

  getRun<ProductState = Record<string, unknown>>(runId: string): AgentRunRecord<ProductState> | null {
    const row = this.database().prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as RunRow | undefined
    return row ? toRun<ProductState>(row) : null
  }

  updateConfigurationSnapshot(
    runId: string,
    snapshot: PersistedRunConfigurationSnapshot
  ): void {
    this.database().prepare(`
      UPDATE agent_runs
      SET config_snapshot_json = ?, config_revision = ?, updated_at = ?
      WHERE id = ?
    `).run(json(snapshot), snapshot.revision, now(), runId)
  }

  *iterateRecoverableRunIds(useCase: string, statuses?: readonly AgentRunStatus[]): Generator<string> {
    yield* this.iterateSelectedRunIds(useCase, statuses, false)
  }

  *iterateCleanupRunIds(useCase: string): Generator<string> {
    yield* this.iterateSelectedRunIds(useCase, undefined, true)
  }

  setResourceCleanupPending(runId: string, pending: boolean): void {
    if (pending) {
      this.database().prepare(`INSERT INTO agent_resource_cleanup (run_id, requested_at)
        VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING`).run(runId, now())
    } else {
      this.database().prepare('DELETE FROM agent_resource_cleanup WHERE run_id = ?').run(runId)
    }
  }

  private *iterateSelectedRunIds(useCase: string, statuses: readonly AgentRunStatus[] | undefined, includeCleanup: boolean): Generator<string> {
    if (!useCase.trim()) throw new Error('Agent use case must not be empty')
    if (statuses?.length === 0) return
    const db = this.database()
    const table = `agent_restore_${randomUUID().replaceAll('-', '')}`
    const statusFilter = statuses ? ` AND status IN (${statuses.map(() => '?').join(',')})` : ''
    const eligibility = includeCleanup
      ? `(status <> 'closed' OR EXISTS (SELECT 1 FROM agent_resource_cleanup AS cleanup WHERE cleanup.run_id = agent_runs.id))`
      : `status <> 'closed'`
    // Snapshot only IDs in SQLite. Preserve updated_at order while recovery
    // updates those timestamps, without retaining every product/config in JS.
    db.exec(`CREATE TEMP TABLE ${table} (position INTEGER PRIMARY KEY, id TEXT NOT NULL)`)
    try {
      db.prepare(`INSERT INTO ${table} (id) SELECT id FROM agent_runs
        WHERE use_case = ? AND ${eligibility}${statusFilter} ORDER BY updated_at ASC, rowid ASC`)
        .run(useCase, ...(statuses ?? []))
      const statement = db.prepare(`SELECT position, id FROM ${table} WHERE position > ? ORDER BY position LIMIT 128`)
      let after = 0
      while (true) {
        const rows = statement.all(after) as Array<{ position: number; id: string }>
        if (rows.length === 0) return
        for (const row of rows) yield row.id
        after = rows[rows.length - 1].position
      }
    } finally { db.exec(`DROP TABLE ${table}`) }
  }

  *iterateRecoverableRuns(useCase: string, statuses?: readonly AgentRunStatus[]): Generator<AgentRunRecord> {
    for (const id of this.iterateRecoverableRunIds(useCase, statuses)) {
      const record = this.getRun(id)
      // A previous asynchronous recovery may have closed a later run.
      if (record && record.useCase === useCase && record.status !== 'closed' &&
        (!statuses || statuses.includes(record.status))) yield record
    }
  }

  findLatestRun<ProductState = Record<string, unknown>>(useCase: string): AgentRunRecord<ProductState> | null {
    const row = this.database().prepare(`
      SELECT * FROM agent_runs
      WHERE use_case = ? AND status <> 'closed'
      ORDER BY updated_at DESC LIMIT 1
    `).get(useCase) as RunRow | undefined
    return row ? toRun<ProductState>(row) : null
  }

  updateProductState<ProductState>(runId: string, status: AgentRunStatus, state: ProductState): void {
    this.database().prepare(`
      UPDATE agent_runs SET status = ?, product_state_json = ?, updated_at = ? WHERE id = ?
    `).run(status, json(state), now(), runId)
  }

  /** Build and commit a state together with any journal appends made by the synchronous builder. */
  updateProductStateFrom<ProductState extends Record<string, unknown>>(
    runId: string,
    status: AgentRunStatus,
    build: (current: AgentRunRecord<ProductState>) => ProductState
  ): ProductState {
    return this.database().transaction(() => {
      const current = this.getRun<ProductState>(runId)
      if (!current) throw new Error('Agent run does not exist')
      const next = build(current)
      this.updateProductState(runId, status, next)
      return next
    })()
  }

  acceptOperation(input: {
    runId: string
    operationId?: string
    commandKind: AgentOperationRecord['commandKind']
    idempotencyKey: string
    content: string
  }): { created: boolean; operation: AgentOperationRecord } {
    const db = this.database()
    const existing = db.prepare(`
      SELECT id, run_id, command_kind, idempotency_key, content_hash, status, created_at, settled_at, error
      FROM agent_operations WHERE run_id = ? AND idempotency_key = ?
    `).get(input.runId, input.idempotencyKey) as {
      id: string; run_id: string; command_kind: AgentOperationRecord['commandKind']; idempotency_key: string
      content_hash: string; status: AgentOperationRecord['status']; created_at: string; settled_at: string | null; error: string | null
    } | undefined
    const contentHash = hash(input.content)
    if (existing) {
      if (existing.content_hash !== contentHash || existing.command_kind !== input.commandKind) {
        throw new Error(`幂等键 ${input.idempotencyKey} 已用于不同命令`)
      }
      return {
        created: false,
        operation: {
          id: existing.id, runId: existing.run_id, commandKind: existing.command_kind,
          idempotencyKey: existing.idempotency_key, contentHash: existing.content_hash,
          status: existing.status, createdAt: existing.created_at,
          settledAt: existing.settled_at ?? undefined, error: existing.error ?? undefined
        }
      }
    }
    const operationId = input.operationId ?? randomUUID()
    const at = now()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO agent_operations (
          id, run_id, command_kind, idempotency_key, content_hash, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'accepted', ?)
      `).run(operationId, input.runId, input.commandKind, input.idempotencyKey, contentHash, at)
      db.prepare(`
        UPDATE agent_runs SET status = 'running', active_operation_id = ?, updated_at = ? WHERE id = ?
      `).run(operationId, at, input.runId)
    })()
    return {
      created: true,
      operation: {
        id: operationId,
        runId: input.runId,
        commandKind: input.commandKind,
        idempotencyKey: input.idempotencyKey,
        contentHash,
        status: 'accepted',
        createdAt: at
      }
    }
  }

  rejectOperation(operationId: string, error: string): void {
    this.database().prepare(`
      UPDATE agent_operations SET status = 'rejected', settled_at = ?, error = ? WHERE id = ?
    `).run(now(), error, operationId)
  }

  settleOperation(operationId: string): void {
    this.database().prepare(`
      UPDATE agent_operations SET status = 'settled', settled_at = ?
      WHERE id = ? AND status = 'accepted'
    `).run(now(), operationId)
  }

  interruptAcceptedOperations(runId: string, reason: string): void {
    this.database().prepare(`
      UPDATE agent_operations SET status = 'failed', settled_at = ?, error = ?
      WHERE run_id = ? AND status = 'accepted'
    `).run(now(), reason, runId)
  }

  appendProductEvent(
    runId: string,
    operationId: string | undefined,
    eventType: string,
    payload: unknown
  ): number {
    const result = this.database().prepare(`
      INSERT INTO agent_product_journal (run_id, operation_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, operationId ?? null, eventType, json(payload), now())
    return Number(result.lastInsertRowid)
  }

  getProductJournalCursor(runId: string): number {
    const row = this.database().prepare(`
      SELECT seq FROM agent_product_journal
      WHERE run_id = ? ORDER BY seq DESC LIMIT 1
    `).get(runId) as { seq: number } | undefined
    return row?.seq ?? 0
  }

  readProductJournal<Event = Record<string, unknown>>(
    runId: string,
    afterSeq = 0,
    limit = 500,
    throughSeq = Number.MAX_SAFE_INTEGER
  ): AgentJournalRecord<Event>[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(throughSeq) || throughSeq < afterSeq) throw new Error('Invalid journal cursor')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Journal page limit must be between 1 and 500')
    const rows = this.database().prepare(`
      SELECT seq, run_id, operation_id, event_type, payload_json, created_at
      FROM agent_product_journal WHERE run_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?
    `).all(runId, afterSeq, throughSeq, limit) as Array<{
      seq: number; run_id: string; operation_id: string | null; event_type: string; payload_json: string; created_at: string
    }>
    return rows.map((row) => ({
      seq: row.seq,
      runId: row.run_id,
      operationId: row.operation_id ?? undefined,
      eventType: row.event_type,
      payload: parse<Event>(row.payload_json),
      createdAt: row.created_at
    }))
  }

  recordArtifact<Ref>(input: {
    artifactId?: string
    runId: string
    operationId?: string
    kind: string
    label: string
    ref: Ref
  }): AgentArtifactRecord<Ref> {
    const artifact: AgentArtifactRecord<Ref> = {
      id: input.artifactId ?? randomUUID(),
      runId: input.runId,
      kind: input.kind.trim(),
      label: input.label.trim(),
      ref: structuredClone(input.ref),
      contentHash: hash(json(input.ref)),
      createdAt: now()
    }
    if (!artifact.kind || !artifact.label) throw new Error('Artifact kind 和 label 不能为空')
    const db = this.database()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO agent_artifacts (id, run_id, kind, label, ref_json, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id,
        artifact.runId,
        artifact.kind,
        artifact.label,
        json(artifact.ref),
        artifact.contentHash,
        artifact.createdAt
      )
      this.appendProductEvent(input.runId, input.operationId, 'artifact.recorded', artifact)
    })()
    return structuredClone(artifact)
  }

  listArtifacts<Ref = Record<string, unknown>>(runId: string): AgentArtifactRecord<Ref>[] {
    const rows = this.database().prepare(`
      SELECT id, run_id, kind, label, ref_json, content_hash, created_at
      FROM agent_artifacts WHERE run_id = ? ORDER BY created_at ASC, id ASC
    `).all(runId) as Array<{
      id: string
      run_id: string
      kind: string
      label: string
      ref_json: string
      content_hash: string
      created_at: string
    }>
    return rows.map((row) => {
      if (hash(row.ref_json) !== row.content_hash) {
        throw new Error(`Artifact ${row.id} 完整性校验失败`)
      }
      return {
        id: row.id,
        runId: row.run_id,
        kind: row.kind,
        label: row.label,
        ref: parse<Ref>(row.ref_json),
        contentHash: row.content_hash,
        createdAt: row.created_at
      }
    })
  }

  commitRuntimeObservation(runId: string, event: RuntimeDurableObservation): void {
    const db = this.database()
    const at = now()
    db.transaction(() => {
      const auditEvent = event.type === 'message.completed'
        ? { type: event.type, audit: event.audit }
        : event.type === 'tool.completed'
          ? { type: event.type, result: event.result }
          : event
      this.appendProductEvent(runId, undefined, `runtime.${event.type}`, auditEvent)
      if (event.type === 'message.completed' || event.type === 'tool.completed') {
        const recovery = event.recovery
        const plaintext = json(recovery)
        db.prepare(`
          INSERT INTO agent_execution_history (
            run_id, runtime_id, codec_version, audit_json, recovery_ciphertext,
            content_hash, created_at
          ) VALUES (?, 'pi', ?, ?, ?, ?, ?)
        `).run(
          runId,
          recovery.codecVersion,
          json(event.type === 'message.completed' ? event.audit : event.result),
          activeCipher().encrypt(plaintext),
          recovery.contentHash,
          at
        )
      }
      if (event.type === 'session.saved') {
        db.prepare(`
          UPDATE agent_runs SET runtime_session_ref_json = ?, updated_at = ? WHERE id = ?
        `).run(json(event.ref), at, runId)
      }
      if (event.type === 'agent.settled') {
        const operationIds = [...event.acceptedCommandIds]
        const settle = db.prepare(`
          UPDATE agent_operations SET status = 'settled', settled_at = ?
          WHERE run_id = ? AND id = ? AND status = 'accepted'
        `)
        for (const operationId of operationIds) settle.run(at, runId, operationId)
        db.prepare(`
          UPDATE agent_runs
          SET status = CASE
                WHEN status IN ('failed', 'cancelled', 'closed') THEN status
                ELSE 'settled'
              END,
              active_operation_id = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(at, runId)
      }
      if (event.type === 'runtime.fault') {
        db.prepare(`
          UPDATE agent_runs SET status = 'failed', updated_at = ? WHERE id = ?
        `).run(at, runId)
        db.prepare(`
          UPDATE agent_operations SET status = 'failed', settled_at = ?, error = ?
          WHERE run_id = ? AND status = 'accepted'
        `).run(at, event.message, runId)
      }
    })()
  }

  readExecutionHistory(runId: string): ExecutionHistoryFrame[] {
    const rows = this.database().prepare(`
      SELECT seq, runtime_id, codec_version, audit_json, recovery_ciphertext, content_hash
      FROM agent_execution_history WHERE run_id = ? ORDER BY seq ASC
    `).all(runId) as Array<{
      seq: number; runtime_id: 'pi'; codec_version: 1; audit_json: string; recovery_ciphertext: Buffer; content_hash: string
    }>
    return rows.map((row) => {
      const recovery = parse<RuntimeRecoveryFrame>(activeCipher().decrypt(row.recovery_ciphertext))
      if (recovery.contentHash !== row.content_hash || hash(recovery.payload) !== row.content_hash) {
        throw new Error(`ExecutionHistory frame ${row.seq} 完整性校验失败`)
      }
      return {
        seq: row.seq,
        runtimeId: row.runtime_id,
        codecVersion: row.codec_version,
        audit: parse(row.audit_json),
        recovery,
        contentHash: row.content_hash
      }
    })
  }

  beginToolCall(input: {
    callId: string
    runId: string
    operationId?: string
    toolName: string
    argsDigest: string
    effect: string
  }): boolean {
    const result = this.database().prepare(`
      INSERT OR IGNORE INTO agent_tool_ledger (
        call_id, run_id, operation_id, tool_name, args_digest, effect, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
    `).run(input.callId, input.runId, input.operationId ?? null, input.toolName, input.argsDigest, input.effect, now())
    return result.changes === 1
  }

  completeToolCall(callId: string, status: 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'denied', result: unknown): void {
    this.database().prepare(`
      UPDATE agent_tool_ledger SET status = ?, result_json = ?, completed_at = ? WHERE call_id = ?
    `).run(status, json(result), now(), callId)
  }

  hasUnreconciledSideEffects(runId: string): boolean {
    const row = this.database().prepare(`
      SELECT 1 FROM agent_tool_ledger
      WHERE run_id = ? AND effect <> 'read' AND status IN ('running', 'uncertain', 'interrupted') LIMIT 1
    `).get(runId)
    return Boolean(row)
  }

  createApproval(input: {
    requestId: string
    runId: string
    callId: string
    argsDigest: string
  }): void {
    this.database().prepare(`
      INSERT OR IGNORE INTO agent_approvals (
        request_id, run_id, call_id, args_digest, status, created_at
      ) VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(input.requestId, input.runId, input.callId, input.argsDigest, now())
  }

  decideApproval(requestId: string, approved: boolean, permit: string | undefined): void {
    this.database().prepare(`
      UPDATE agent_approvals SET status = ?, permit_ciphertext = ?, decided_at = ?
      WHERE request_id = ? AND status = 'pending'
    `).run(
      approved ? 'approved' : 'denied',
      permit ? activeCipher().encrypt(permit) : null,
      now(),
      requestId
    )
  }

  denyPendingApprovals(runId: string, exceptRequestId?: string): number {
    const result = this.database().prepare(`
      UPDATE agent_approvals
      SET status = 'denied', permit_ciphertext = NULL, decided_at = ?
      WHERE run_id = ? AND status = 'pending'
        AND (? IS NULL OR request_id <> ?)
    `).run(now(), runId, exceptRequestId ?? null, exceptRequestId ?? null)
    return result.changes
  }

  revokeApproval(runId: string, requestId: string): boolean {
    const result = this.database().prepare(`
      UPDATE agent_approvals
      SET status = 'denied', permit_ciphertext = NULL, decided_at = ?
      WHERE run_id = ? AND request_id = ? AND status = 'approved'
    `).run(now(), runId, requestId)
    return result.changes === 1
  }

  discardOpenApprovals(runId: string): number {
    const result = this.database().prepare(`
      UPDATE agent_approvals
      SET status = 'denied', permit_ciphertext = NULL, decided_at = ?
      WHERE run_id = ? AND status IN ('pending', 'approved')
    `).run(now(), runId)
    return result.changes
  }

  consumeApproval(requestId: string, permit: string): boolean {
    const row = this.database().prepare(`
      SELECT permit_ciphertext FROM agent_approvals
      WHERE request_id = ? AND status = 'approved'
    `).get(requestId) as { permit_ciphertext: Buffer | null } | undefined
    if (!row?.permit_ciphertext) return false
    if (activeCipher().decrypt(row.permit_ciphertext) !== permit) return false
    const result = this.database().prepare(`
      UPDATE agent_approvals SET status = 'consumed' WHERE request_id = ? AND status = 'approved'
    `).run(requestId)
    return result.changes === 1
  }

  listPendingApprovals(runId: string): Array<{
    requestId: string
    callId: string
    toolName: string
    argsDigest: string
  }> {
    const rows = this.database().prepare(`
      SELECT approvals.request_id, approvals.call_id, ledger.tool_name, approvals.args_digest
      FROM agent_approvals AS approvals
      JOIN agent_tool_ledger AS ledger ON ledger.call_id = approvals.call_id
      WHERE approvals.run_id = ? AND approvals.status = 'pending'
      ORDER BY approvals.created_at ASC
    `).all(runId) as Array<{
      request_id: string
      call_id: string
      tool_name: string
      args_digest: string
    }>
    return rows.map((row) => ({
      requestId: row.request_id,
      callId: row.call_id,
      toolName: row.tool_name,
      argsDigest: row.args_digest
    }))
  }

  listApprovedPermits(runId: string): Array<{
    requestId: string
    toolName: string
    argsDigest: string
    permit: string
  }> {
    const rows = this.database().prepare(`
      SELECT approvals.request_id, ledger.tool_name, approvals.args_digest, approvals.permit_ciphertext
      FROM agent_approvals AS approvals
      JOIN agent_tool_ledger AS ledger ON ledger.call_id = approvals.call_id
      WHERE approvals.run_id = ? AND approvals.status = 'approved'
      ORDER BY approvals.created_at ASC
    `).all(runId) as Array<{
      request_id: string
      tool_name: string
      args_digest: string
      permit_ciphertext: Buffer
    }>
    return rows.map((row) => ({
      requestId: row.request_id,
      toolName: row.tool_name,
      argsDigest: row.args_digest,
      permit: activeCipher().decrypt(row.permit_ciphertext)
    }))
  }

  markRecovering(runId: string): void {
    this.database().prepare(`UPDATE agent_runs SET status = 'recovering', updated_at = ? WHERE id = ?`).run(now(), runId)
  }

  beginRecoveryAttempt(runId: string, generation: number): boolean {
    const result = this.database().prepare(`
      UPDATE agent_runs SET recovery_attempted_generation = ?, status = 'recovering', updated_at = ?
      WHERE id = ? AND recovery_attempted_generation < ?
    `).run(generation, now(), runId, generation)
    return result.changes === 1
  }

  commitRebuild(runId: string, ref: OpaqueRuntimeSessionRef): void {
    const db = this.database()
    db.transaction(() => {
      db.prepare(`
        UPDATE agent_runs SET status = 'settled', runtime_session_ref_json = ?,
          recovery_generation = recovery_generation + 1, updated_at = ? WHERE id = ?
      `).run(json(ref), now(), runId)
      this.appendProductEvent(runId, undefined, 'runtime.rebuilt', {
        ref,
        breakReason: 'runtime-rebuild',
        expectedFirstCacheMiss: true
      })
    })()
  }

  closeRun(runId: string): void {
    const at = now()
    this.database().prepare(`
      UPDATE agent_runs SET status = 'closed', active_operation_id = NULL, closed_at = ?, updated_at = ? WHERE id = ?
    `).run(at, at, runId)
  }
}

export const agentRunStore = new AgentRunStore()

export function setAgentPayloadCipherForTests(cipher: AgentPayloadCipher | null): void {
  cipherOverride = cipher
}
