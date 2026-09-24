export interface PlayGrantInput {
  libraryId: number
  videoId: number
  resourceId: number
  locatorRevision: string
}

export interface PlayGrant {
  grantId: string
  resourceId: number
  expiresAt: string
  /** Opaque URL consumed by the desktop player host, never shown raw to renderer. */
  playbackHandle: string
  methods: Array<'HEAD' | 'GET'>
  range: true
}

export type FileLocationDisplay = {
  rootId: number
  rootName: string
  relativePath: string
}

export type ResourceAction =
  | 'play'
  | 'openExternal'
  | 'copyLink'
  | 'revealLocal'
  | 'revealUnavailable'
