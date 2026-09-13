export type WriterClaimKind = 'initialBind' | 'handoff' | 'deployRecover'

export interface WriterCandidate {
  claimId: string
  secretDigest: string
}

export interface WriterClaimInput {
  kind: WriterClaimKind
  oneTimeToken: string
  candidate: WriterCandidate
}

export type WriterClaimStatus = 'pending' | 'waitingMaintenance' | 'consumed' | 'expired' | 'superseded'

export interface WriterClaimResult {
  claimId: string
  status: WriterClaimStatus
  writerEpoch: number
  bound: boolean
}

export interface WriterStatus {
  writerEpoch: number
  bound: boolean
  claimId: string | null
  waitingMaintenance: boolean
}
