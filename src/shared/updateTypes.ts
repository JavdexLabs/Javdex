export type UpdateCheckStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error'

export type UpdateCheckErrorCode =
  | 'network-unavailable'
  | 'rate-limited'
  | 'invalid-response'
  | 'repository-unavailable'
  | 'unknown'

export interface AppReleaseInfo {
  version: string
  tagName: string
  releaseName: string
  releaseUrl: string
  publishedAt: string | null
  releaseNotes: string
}

export interface UpdateCheckState {
  status: UpdateCheckStatus
  currentVersion: string
  latestRelease?: AppReleaseInfo
  checkedAt?: string
  ignoredVersion?: string
  errorCode?: UpdateCheckErrorCode
}
