import type Database from 'better-sqlite3'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { readCatalogIdentity } from '@library/catalog/catalogIdentity'
import { commitCatalogMutation, readCatalogMutation, digestCatalogMutation, type CatalogMutationRequest } from '@library/catalog/catalogOperations'
import { structuredError } from '@shared/protocol/errors'
import type { AgentMetadataTarget } from '@shared/agentMetadataTypes'
import type { AgentMetadataApplyCommit } from './draftApplyCommit'

interface DiscardIntent {
  draft_id: string
  catalog_id: string
  operation_id: string
  request_json: string
  revision: number
  kind: AgentMetadataTarget['kind']
  staged_paths_json: string
  cleaned: number
}

type Cleanup = (kind: AgentMetadataTarget['kind'], paths: string[]) => void

/** Catalog acknowledgement precedes work mutation; cleanup remains retryable. */
export class AgentMetadataDiscardCommit {
  private readonly repo: AgentMetadataDraftRepo
  constructor(private readonly work: Database.Database, private readonly catalog: Database.Database,
    private readonly applications: AgentMetadataApplyCommit) {
    this.repo = new AgentMetadataDraftRepo(() => work)
  }

  discard(draftId: string, request: CatalogMutationRequest, cleanup: Cleanup): { ok: boolean } {
    const identity = readCatalogIdentity(this.catalog)
    if (!identity) throw new Error('草稿丢弃缺少资料库身份')
    const intent = this.work.transaction(() => {
      const existing = this.work.prepare('SELECT * FROM agent_metadata_discard_intents WHERE draft_id=?').get(draftId) as DiscardIntent | undefined
      if (existing) {
        const original = JSON.parse(existing.request_json) as CatalogMutationRequest
        if (existing.catalog_id !== identity.catalogId || original.operationId !== request.operationId ||
          digestCatalogMutation(original) !== digestCatalogMutation(request)) throw new Error('请使用原草稿丢弃请求重试')
        return existing
      }
      this.applications.assertMutable(draftId)
      const draft = this.repo.require(draftId)
      if (draft.status !== 'ready' || draft.revision !== request.expectedVersions.Q?.revision) {
        throw structuredError('VERSION_CONFLICT', '草稿已变化，请刷新后丢弃', { field: 'expectedVersions.Q' })
      }
      const reserved: DiscardIntent = { draft_id: draftId, catalog_id: identity.catalogId,
        operation_id: request.operationId, request_json: JSON.stringify(request), revision: draft.revision,
        kind: draft.target.kind, staged_paths_json: JSON.stringify(draft.resources.map(resource => resource.stagedPath)), cleaned: 0 }
      this.work.prepare(`INSERT INTO agent_metadata_discard_intents
        (draft_id,catalog_id,operation_id,request_json,revision,kind,staged_paths_json)
        VALUES(@draft_id,@catalog_id,@operation_id,@request_json,@revision,@kind,@staged_paths_json)`).run(reserved)
      return reserved
    })()
    try {
      if (!readCatalogMutation(request, this.catalog)) commitCatalogMutation(request, () => ({ ok: true }), this.catalog)
    } catch (error) {
      if (!readCatalogMutation(request, this.catalog)) {
        this.work.prepare('DELETE FROM agent_metadata_discard_intents WHERE draft_id=? AND operation_id=?').run(draftId, request.operationId)
      }
      throw error
    }
    this.finish(intent, cleanup)
    return { ok: true }
  }

  recoverCommitted(cleanup: Cleanup): void {
    const identity = readCatalogIdentity(this.catalog)
    if (!identity) throw new Error('草稿丢弃恢复缺少资料库身份')
    const intents = this.work.prepare('SELECT * FROM agent_metadata_discard_intents WHERE catalog_id=? AND cleaned=0')
      .all(identity.catalogId) as DiscardIntent[]
    for (const intent of intents) {
      if (readCatalogMutation(JSON.parse(intent.request_json) as CatalogMutationRequest, this.catalog)) this.finish(intent, cleanup)
    }
  }

  private finish(intent: DiscardIntent, cleanup: Cleanup): void {
    if (intent.cleaned) return
    const draft = this.repo.require(intent.draft_id)
    if (draft.status === 'ready' && draft.revision === intent.revision) {
      this.repo.discard({ draftId: draft.id, expectedRevision: intent.revision })
    } else if (draft.status !== 'discarded' || draft.revision !== intent.revision + 1) {
      throw new Error('草稿状态与已确认的丢弃不一致，不能完成清理')
    }
    cleanup(intent.kind, JSON.parse(intent.staged_paths_json) as string[])
    this.work.prepare('UPDATE agent_metadata_discard_intents SET cleaned=1 WHERE draft_id=? AND operation_id=?')
      .run(intent.draft_id, intent.operation_id)
  }
}
