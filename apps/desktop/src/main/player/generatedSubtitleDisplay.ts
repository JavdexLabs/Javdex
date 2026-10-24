import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
import type { PlaybackHostBridge } from './playbackHostFactory'

type SubtitleDisplay = Pick<NativePlayback, 'addSubtitle' | 'updateGeneratedSubtitle' | 'removeGeneratedSubtitle' | 'generatedSubtitleSelected'
  | 'subtitleCommandErrors' | 'generatedSubtitleCommandErrors' | 'selectedAudioStream'>
/** Generated subtitles own a logical selection and asynchronous acknowledgements,
 * independently of resource transport, presentation and the playback engine. */
export function createGeneratedSubtitleDisplay(platform = process.platform) {
  const generatedId = Number.MAX_SAFE_INTEGER
  let bridge: PlaybackHostBridge | null = null
  let alive = false
  let generation = 0
  let generatedRepliesExpected = 0
  let subtitleSelectionRevision = 0
  let overlayRevision = 0
  let generated: { file: string; visible: boolean; ownsSelection: boolean } | null = null
  const command = (args: string[], generatedSubtitle = false): void => {
    if (!alive || !bridge) throw new Error('播放内核未启动')
    const state = bridge.inspect()
    bridge.command(args, generatedSubtitle)
    if (generatedSubtitle && (['sub-add', 'sub-reload', 'sub-remove'].includes(args[0])
      || args[0] === 'set' && ['sid', 'sub-delay', 'sub-font-size'].includes(args[1]))) {
      // Linux sends through a pipe: its last snapshot may predate this command.
      generatedRepliesExpected = Math.max(generatedRepliesExpected, (state.generatedSubtitleCommandReplies ?? 0) + (state.generatedSubtitleCommandsPending ?? 0)) + 1
    }
  }
  const nativeTracks = (state = bridge?.inspect()): Array<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(state?.['track-list'] ?? '[]')
      if (!Array.isArray(value)) return []
      const tracks = value.filter(item => item && typeof item === 'object').map((track: Record<string, unknown>) => {
        const selection = track.type === 'sub' ? state?.sid : track.type === 'audio' ? state?.aid : undefined
        // track-list observations can retain old selected flags after a sid/aid change.
        return selection === 'no' || /^\d+$/.test(selection ?? '') ? { ...track, selected: String(track.id) === selection } : track
      })
      if (generated) tracks.push({ id: generatedId, type: 'sub', selected: generated.visible && state?.sid === 'no',
        title: 'AI 日中字幕', codec: 'ass', 'external-filename': generated.file })
      return tracks
    } catch { return [] }
  }
  const matchesGenerated = (file: string): boolean => {
    const normalize = (filename: string): string => platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename)
    return generated !== null && normalize(generated.file) === normalize(file)
  }
  const overlay = (operation: 'update' | 'visible' | 'clear', document = '', visible = false): number => {
    if (!alive || !bridge?.generatedSubtitles || bridge.inspect().generatedSubtitleOverlayVersion !== 1)
      throw new Error('播放运行库需更新，请重新构建播放运行库并重启应用')
    const revision = ++overlayRevision
    bridge.generatedSubtitles(operation, document, visible, revision)
    return revision
  }
  const showGenerated = (visible: boolean): void => {
    if (!generated || generated.visible === visible) return
    generated.visible = visible
    overlay('visible', '', visible)
  }
  async function subtitleIdle(epoch: number): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      if (!alive || !bridge || generation !== epoch) throw new Error('播放会话已结束')
      const state = bridge.inspect()
      if ((state.generatedSubtitleCommandsPending == null || state.generatedSubtitleCommandErrors == null) && platform !== 'linux') throw new Error('播放运行库需更新，请重新构建播放运行库并重启应用')
      if (state.generatedSubtitleCommandsPending === 0 && (state.generatedSubtitleCommandReplies ?? -1) >= generatedRepliesExpected) return
      if (Date.now() >= deadline) throw new Error('等待播放器更新字幕超时')
      // The platform render loop drains replies; Linux delivers them in snapshots.
      await delay(20)
    }
  }
  async function subtitleState(epoch: number, matches: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      if (!alive || generation !== epoch) throw new Error('播放会话已结束')
      if (matches()) return
      if (Date.now() >= deadline) throw new Error('等待播放器字幕轨道状态超时')
      // Command replies may arrive before the corresponding property observation.
      await delay(20)
    }
  }
  const display: SubtitleDisplay = {
    addSubtitle(file): void { subtitleSelectionRevision++; if (generated) generated.ownsSelection = false; showGenerated(false); command(['sub-add', file, 'select']) },
    async updateGeneratedSubtitle(file, select, signal, document): Promise<void> {
      const epoch = generation
      const selection = subtitleSelectionRevision
      await subtitleIdle(epoch)
      signal?.throwIfAborted()
      const errors = bridge?.inspect().generatedSubtitleCommandErrors ?? 0
      if (typeof document !== 'string') throw new Error('缺少生成的字幕时间轴')
      if (!bridge?.generatedSubtitles || bridge.inspect().generatedSubtitleOverlayVersion !== 1)
        throw new Error('播放运行库需更新，请重新构建播放运行库并重启应用')
      if (!matchesGenerated(file)) generated = { file, visible: false, ownsSelection: false }
      const owner = generated!
      if (select && selection === subtitleSelectionRevision) {
        command(['set', 'sid', 'no'], true)
        owner.ownsSelection = true
        await subtitleIdle(epoch)
        await subtitleState(epoch, () => signal?.aborted === true || selection !== subtitleSelectionRevision || bridge?.inspect().sid === 'no')
        signal?.throwIfAborted()
        if (selection === subtitleSelectionRevision && generated === owner) owner.visible = true
      }
      if (!alive || generation !== epoch) throw new Error('播放会话已结束')
      if (generated !== owner) return
      const revision = overlay('update', document, owner.visible)
      await subtitleState(epoch, () => (bridge?.inspect().generatedSubtitleRevision ?? 0) >= revision)
      await subtitleIdle(epoch)
      signal?.throwIfAborted()
      if ((bridge?.inspect().generatedSubtitleCommandErrors ?? 0) > errors) throw new Error('播放器未能更新 AI 字幕显示')
    },
    async removeGeneratedSubtitle(file, restoreId): Promise<void> {
      const epoch = generation, selection = subtitleSelectionRevision
      await subtitleIdle(epoch)
      const errors = bridge?.inspect().generatedSubtitleCommandErrors ?? 0
      if (!matchesGenerated(file)) return
      // Ownership records the command intent, even if a sid observation is late
      // or startup was cancelled between its reply and the property event.
      const selected = generated!.ownsSelection
      generated = null
      const revision = overlay('clear')
      await subtitleState(epoch, () => (bridge?.inspect().generatedSubtitleRevision ?? 0) >= revision)
      await subtitleIdle(epoch)
      if ((bridge?.inspect().generatedSubtitleCommandErrors ?? 0) > errors) throw new Error('播放器未能移除生成的字幕')
      if (selected && selection === subtitleSelectionRevision) {
        command(['set', 'sid', restoreId !== null && nativeTracks().some(item => item.type === 'sub' && item.id === restoreId) ? String(restoreId) : 'no'], true)
        await subtitleIdle(epoch)
      }
    },
    generatedSubtitleSelected: file => matchesGenerated(file) && generated!.visible && bridge?.inspect().sid === 'no',
    subtitleCommandErrors: () => bridge?.inspect().subtitleCommandErrors ?? 0,
    generatedSubtitleCommandErrors: () => bridge?.inspect().generatedSubtitleCommandErrors ?? 0,
    selectedAudioStream(): number | null {
      const track = nativeTracks().find(track => track.type === 'audio' && track.selected === true)
      const index = track?.['ff-index']
      return track && !track.external && typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null
    },
  }
  return {
    display, command,
    bind(host: PlaybackHostBridge): void {
      generation++; bridge = host; alive = true; generatedRepliesExpected = 0; overlayRevision = 0; generated = null
    },
    loaded(): void { generation++; generated = null },
    destroy(): void { generation++; generated = null; alive = false; bridge = null },
    decorate(value: NativePlaybackState): NativePlaybackState {
      if (value['track-list'] || generated) value['track-list'] = JSON.stringify(nativeTracks(value))
      return value
    },
    selectTrack(type: 'sub' | 'audio', id: number | null): void {
        if (type === 'sub') {
          subtitleSelectionRevision++
          if (id === generatedId && generated) {
            generated.ownsSelection = true
            command(['set', 'sid', 'no']); showGenerated(true)
          } else { if (generated) generated.ownsSelection = false; showGenerated(false); command(['set', 'sid', id === null ? 'no' : String(id)]) }
        } else command(['set', 'aid', id === null ? 'no' : String(id)])
    }
  }
}
