export type WriterClaimKind = 'initialBind' | 'handoff' | 'deployRecover' | 'deviceAdd'

export interface WriterCandidate {
  claimId: string
  secretDigest: string
  name?: string
}

export interface TrustedDevice {
  id: string
  name: string
  createdAt: string
  current: boolean
}

export interface WriterClaimInput {
  kind: WriterClaimKind
  oneTimeToken: string
  candidate: WriterCandidate
}

export type WriterClaimStatus = 'pending' | 'consumed' | 'expired' | 'superseded'

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
  maintenanceBusy: boolean
}
