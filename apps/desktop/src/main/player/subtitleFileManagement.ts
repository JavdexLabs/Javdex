import type { PlaybackTarget } from '@shared/desktop/playback'
import type { SubtitleFilesSnapshot } from '@shared/desktop/subtitleTasks'
import type { PlaybackSource } from './playbackSource'

interface Dependencies {
  resolve(target: PlaybackTarget): Promise<PlaybackSource>
  validate(source: PlaybackSource): Promise<void>
  files(source: PlaybackSource): Promise<SubtitleFilesSnapshot>
  associate(source: PlaybackSource, files: string[]): Promise<void>
  choose(): Promise<string[] | null>
  changed(source: PlaybackSource): void
}

/** Resource management does not need a playback session or an AI runtime. */
export function createSubtitleFileManagement(deps: Dependencies) {
  return {
    async list(target: PlaybackTarget): Promise<SubtitleFilesSnapshot> {
      return deps.files(await deps.resolve(target))
    },
    async add(target: PlaybackTarget): Promise<SubtitleFilesSnapshot | null> {
      const source = await deps.resolve(target)
      const selected = await deps.choose()
      if (!selected?.length) return null
      await deps.validate(source)
      await deps.associate(source, selected)
      deps.changed(source)
      return deps.files(source)
    }
  }
}
