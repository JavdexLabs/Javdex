import fs from 'node:fs'
import path from 'node:path'
import { createAuthorizedMediaLibraryRootFileInspector, MediaLibraryRootFileMissingError } from '@library/scan/mediaLibraryRootFileGuard'
import { resourceLocatorRevision } from '@library/catalog/catalogPlay'
import type { PlaybackTarget } from '@shared/desktop/playback'
import type { CatalogBackend } from '../application/catalogBackend'
import { playbackResumeKey } from './playbackResumeStore'
import type { VideoResource } from '@shared/videoTypes'
import { PlaybackFailure } from './playbackFailure'

export interface PlaybackSource {
  target: PlaybackTarget
  title: string
  mode: 'local' | 'remote'
  /** Main-only; never spread this object into IPC state. */
  locator: string
  identityKey: string
  revision: string
  /** Stable device progress key; deliberately excludes writer epoch and session generation. */
  resumeKey: string
  /** Main-only physical file identity; rechecked even for manually imported files. */
  fileIdentity?: string
}
export function playbackCatalogKey(backend: CatalogBackend): string {
  const session = backend.session()
  return JSON.stringify([backend.identity.mode, backend.identity.catalogId, backend.identity.serverId ?? null,
    backend.generation, session.writerEpoch, session.state])
}

export function createPlaybackSourceResolver(backend: CatalogBackend) {
  const inspectFile = (resource: VideoResource): { locator: string; fileIdentity: string } => {
    if (!path.isAbsolute(resource.locator)) throw new PlaybackFailure('file')
    let locator: string
    let stat: fs.Stats
    if (resource.root_id != null) {
      try {
        const checked = createAuthorizedMediaLibraryRootFileInspector()(resource.library_id, resource.root_id, resource.locator)
        locator = checked.fileRealPath; stat = checked.stat
      } catch (error) { throw new PlaybackFailure(error instanceof MediaLibraryRootFileMissingError ? 'missing' : 'root') }
    } else {
      // An explicit manual import already authorized this catalog locator. Never accept a renderer path.
      try {
        locator = fs.realpathSync.native(resource.locator)
        stat = fs.statSync(locator)
        if (!stat.isFile()) throw new PlaybackFailure('file')
      } catch (error) {
        if (error instanceof PlaybackFailure) throw error
        const code = (error as NodeJS.ErrnoException).code
        throw new PlaybackFailure(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'file')
      }
    }
    return { locator, fileIdentity: JSON.stringify([locator, stat.dev, stat.ino, stat.size, stat.mtimeMs]) }
  }
  const inspect = async (target: PlaybackTarget) => {
    const identityKey = playbackCatalogKey(backend)
    if (backend.session().state !== 'available') throw new PlaybackFailure(backend.session().state === 'authInvalid' ? 'authorization' : 'connection')
    const library = await backend.libraries.get({ libraryId: target.libraryId })
    if (!library || library.status !== 'active') throw new PlaybackFailure('library')
    const resource = await backend.queries.getResource(target)
    if (!resource || resource.video_id !== target.videoId || resource.library_id !== target.libraryId) {
      throw new PlaybackFailure('resource')
    }
    if (resource.kind !== 'local') throw new PlaybackFailure('unsupported')
    if (identityKey !== playbackCatalogKey(backend)) throw new PlaybackFailure('identity')
    return { resource, identityKey }
  }
  return {
    async resolve(target: PlaybackTarget): Promise<PlaybackSource> {
      const { resource, identityKey } = await inspect(target)
      const revision = resource.locatorRevision ?? resourceLocatorRevision(resource)
      let locator: string
      let fileIdentity: string | undefined
      if (backend.mode === 'remote') {
        const grant = await backend.assets.grantPlayback({ ...target, locatorRevision: revision })
        let url: URL
        try { url = new URL(grant.playbackHandle) } catch { throw new PlaybackFailure('grant') }
        if (grant.resourceId !== target.resourceId || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          throw new PlaybackFailure('grant')
        }
        locator = grant.playbackHandle
      } else {
        const checked = inspectFile(resource)
        locator = checked.locator; fileIdentity = checked.fileIdentity
      }
      if (identityKey !== playbackCatalogKey(backend)) throw new PlaybackFailure('identity')
      return { target, title: resource.display_name || '影片播放', mode: backend.mode, locator, identityKey, revision,
        resumeKey: playbackResumeKey(backend.identity, target.resourceId, fileIdentity ? JSON.stringify([revision, fileIdentity]) : revision), fileIdentity }
    },
    async validate(source: PlaybackSource): Promise<void> {
      const { resource, identityKey } = await inspect(source.target)
      if (identityKey !== source.identityKey || (resource.locatorRevision ?? resourceLocatorRevision(resource)) !== source.revision) {
        throw new PlaybackFailure('identity')
      }
      if (backend.mode === 'local' && inspectFile(resource).fileIdentity !== source.fileIdentity) {
        throw new PlaybackFailure('identity')
      }
    }
  }
}
