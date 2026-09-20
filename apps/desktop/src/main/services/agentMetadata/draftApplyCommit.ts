import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentMetadataApplyInput, AgentMetadataApplyOutcome, AgentMetadataTarget } from '@shared/agentMetadataTypes'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { readCatalogIdentity } from '@library/catalog/catalogIdentity'
import { commitCatalogMutation, readCatalogMutation, type CatalogMutationRequest } from '@library/catalog/catalogOperations'
import { mediaAssetStore } from '@library/mediaAssetStore'

export interface AgentDraftCatalogResult {
  outcome: Exclude<AgentMetadataApplyOutcome, { status: 'preview_stale' }>
  cleanup: { kind: AgentMetadataTarget['kind']; stagedPaths: string[] }
}

interface ApplyIntent {
  draft_id: string
  catalog_id: string
  review_token: string
  operation_id: string
  request_json: string
  cleaned: number
}

/** Durable local draft handoff: catalog receipt first, work completion second, cleanup last. */
export class AgentMetadataApplyCommit {
  private readonly repo: AgentMetadataDraftRepo

  constructor(
    private readonly work: Database.Database,
    private readonly catalog: Database.Database
  ) {
    this.repo = new AgentMetadataDraftRepo(() => work)
  }

  /** Check receipts before inspecting staging or recomputing a preview. */
  resume(input: AgentMetadataApplyInput, cleanup: (result: AgentDraftCatalogResult['cleanup']) => void): AgentMetadataApplyOutcome | null {
    const intent = this.work.prepare('SELECT * FROM agent_metadata_apply_intents WHERE draft_id=?')
      .get(input.draftId) as ApplyIntent | undefined
    if (!intent) return null
    const identity = readCatalogIdentity(this.catalog)
    if (identity?.catalogId !== intent.catalog_id || input.reviewToken !== intent.review_token) {
      throw new Error('草稿仍有未核对的提交，不能改用其它资料库或预览')
    }
    const receipt = readCatalogMutation<AgentDraftCatalogResult>(
      JSON.parse(intent.request_json) as CatalogMutationRequest, this.catalog
    )
    if (!receipt) return null
    this.finish(intent, receipt.data, cleanup)
    return receipt.data.outcome
  }

  assertMutable(draftId: string): void {
    if (this.work.prepare('SELECT 1 FROM agent_metadata_apply_intents WHERE draft_id=? AND cleaned=0').get(draftId)) {
      throw new Error('草稿仍有未核对的提交，请先重试应用再修改或丢弃。')
    }
  }

  /** Release only a locally verified, uncommitted attempt after preview validation fails. */
  releaseUncommitted(input: AgentMetadataApplyInput): void {
    const intent = this.work.prepare('SELECT * FROM agent_metadata_apply_intents WHERE draft_id=?')
      .get(input.draftId) as ApplyIntent | undefined
    if (!intent) return
    if (readCatalogIdentity(this.catalog)?.catalogId !== intent.catalog_id || input.reviewToken !== intent.review_token) {
      throw new Error('草稿提交身份不一致，不能释放待核对记录。')
    }
    const receipt = readCatalogMutation<AgentDraftCatalogResult>(
      JSON.parse(intent.request_json) as CatalogMutationRequest, this.catalog
    )
    if (receipt) throw new Error('草稿已提交，请先恢复完成状态。')
    this.work.prepare('DELETE FROM agent_metadata_apply_intents WHERE draft_id=? AND operation_id=?')
      .run(intent.draft_id, intent.operation_id)
  }

  apply(
    input: AgentMetadataApplyInput,
    applyCatalog: () => AgentDraftCatalogResult,
    cleanup: (result: AgentDraftCatalogResult['cleanup']) => void
  ): AgentMetadataApplyOutcome {
    const identity = readCatalogIdentity(this.catalog)
    if (!identity) throw new Error('草稿应用缺少资料库身份')
    const intent = this.reserve(input, identity.catalogId, identity.writerEpoch)
    const request = JSON.parse(intent.request_json) as CatalogMutationRequest
    let result: AgentDraftCatalogResult
    try {
      const replay = readCatalogMutation<AgentDraftCatalogResult>(request, this.catalog)
      result = replay?.data ?? mediaAssetStore.coordinateDatabaseChange(() => commitCatalogMutation(
        request, () => {
          // A crash may leave an intent without a catalog receipt. Never apply
          // a subsequently edited draft using the old operation's identity.
          const draft = this.repo.require(intent.draft_id)
          const review = this.repo.getStoredReview(intent.draft_id)
          const reserved = request.input as { revision: number }
          if (draft.status !== 'ready' || draft.revision !== reserved.revision ||
            review?.token !== intent.review_token || !review.canApply) {
            throw new Error('草稿在提交后已变化，请重新检查后再应用。')
          }
          return applyCatalog()
        }, this.catalog
      ).data)
    } catch (error) {
      // A thrown synchronous transaction with no receipt has no catalog commit.
      // Leave uncertain/read failures intact so the next attempt can inspect it.
      if (!readCatalogMutation<AgentDraftCatalogResult>(request, this.catalog)) {
        this.work.prepare('DELETE FROM agent_metadata_apply_intents WHERE draft_id=? AND operation_id=?')
          .run(input.draftId, intent.operation_id)
      }
      throw error
    }
    this.finish(intent, result, cleanup)
    return result.outcome
  }

  /** Startup recovery only finishes proven commits; it never starts a new catalog write. */
  recoverCommitted(cleanup: (result: AgentDraftCatalogResult['cleanup']) => void): number {
    const identity = readCatalogIdentity(this.catalog)
    if (!identity) throw new Error('草稿恢复缺少资料库身份')
    const intents = this.work.prepare('SELECT * FROM agent_metadata_apply_intents WHERE catalog_id=? AND cleaned=0 ORDER BY draft_id')
      .all(identity.catalogId) as ApplyIntent[]
    let recovered = 0
    for (const intent of intents) {
      const committed = readCatalogMutation<AgentDraftCatalogResult>(
        JSON.parse(intent.request_json) as CatalogMutationRequest, this.catalog
      )
      if (!committed) continue
      this.finish(intent, committed.data, cleanup)
      recovered += 1
    }
    return recovered
  }

  private reserve(input: AgentMetadataApplyInput, catalogId: string, writerEpoch: number): ApplyIntent {
    return this.work.transaction(() => {
      const existing = this.work.prepare('SELECT * FROM agent_metadata_apply_intents WHERE draft_id=?')
        .get(input.draftId) as ApplyIntent | undefined
      if (existing) {
        if (existing.catalog_id !== catalogId || existing.review_token !== input.reviewToken) {
          throw new Error('草稿仍有未核对的提交，不能改用其它资料库或预览')
        }
        return existing
      }
      const draft = this.repo.require(input.draftId)
      const review = this.repo.getStoredReview(input.draftId)
      if (draft.status !== 'ready' || review?.token !== input.reviewToken || !review.canApply) {
        throw new Error('预览已过期，请重新检查后再应用。')
      }
      const request: CatalogMutationRequest = {
        operationId: randomUUID(), operation: 'agentMetadata.apply', writerEpoch,
        expectedVersions: {}, input: {
          draftId: input.draftId, reviewToken: input.reviewToken,
          revision: draft.revision, target: draft.target
        }
      }
      const intent: ApplyIntent = { draft_id: input.draftId, catalog_id: catalogId,
        review_token: input.reviewToken, operation_id: request.operationId, request_json: JSON.stringify(request), cleaned: 0 }
      this.work.prepare(`INSERT INTO agent_metadata_apply_intents(draft_id,catalog_id,review_token,operation_id,request_json)
        VALUES(@draft_id,@catalog_id,@review_token,@operation_id,@request_json)`).run(intent)
      return intent
    })()
  }

  private finish(intent: ApplyIntent, result: AgentDraftCatalogResult, cleanup: (result: AgentDraftCatalogResult['cleanup']) => void): void {
    if (!this.repo.getStoredOutcome({ draftId: intent.draft_id, idempotencyKey: intent.operation_id })) {
      this.repo.completeApply({ draftId: intent.draft_id, reviewToken: intent.review_token,
        idempotencyKey: intent.operation_id, outcome: result.outcome })
    }
    // Keep the intent if either completion or cleanup fails. The receipt has the
    // immutable result, so retry does not need to re-read deleted staging files.
    if (intent.cleaned) return
    cleanup(result.cleanup)
    this.work.prepare('UPDATE agent_metadata_apply_intents SET cleaned=1 WHERE draft_id=? AND operation_id=?')
      .run(intent.draft_id, intent.operation_id)
  }
}
