import type { PlaybackTrack } from '@shared/desktop/playback'

export function playbackTrackLabel(track: PlaybackTrack): string {
  const title = track.title?.trim() || `${track.type === 'audio' ? '音轨' : '字幕'} ${track.id}`
  return [title, track.language?.trim(), track.codec?.toUpperCase(),
    track.type === 'audio' && track.channelCountHint != null ? `${track.channelCountHint} 声道` : null]
    .filter(value => value).join(' · ')
}
