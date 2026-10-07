export interface SubtitleCue {
  start: number
  end: number
  japanese: string
  chinese?: string
}
export type SubtitleDisplay = 'bilingual' | 'chinese' | 'japanese'
export const SUBTITLE_CHUNK_SECONDS = 30
export const SUBTITLE_CONTEXT_SECONDS = 3

function cleanText(value: string): string {
  return value.replace(/\[[A-Z_]+\]/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1800)
}
/** ASR times are relative to extracted audio; all persisted cues use source-media time. */
export function parseWhisperCues(value: unknown, extractStart: number, start: number, end: number): SubtitleCue[] {
  if (!value || typeof value !== 'object') throw new Error('日语识别结果格式无效')
  const segments = (value as { transcription?: unknown }).transcription
  if (!Array.isArray(segments)) throw new Error('日语识别结果缺少时间戳')
  return segments.slice(0, 1000).flatMap(segment => {
    if (!segment || typeof segment !== 'object') return []
    const offsets = segment.offsets as { from?: unknown; to?: unknown } | undefined
    if (typeof offsets?.from !== 'number' || typeof offsets.to !== 'number' || typeof segment.text !== 'string') return []
    const from = extractStart + offsets.from / 1000, to = extractStart + offsets.to / 1000
    const midpoint = (from + to) / 2
    const japanese = cleanText(segment.text)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || midpoint < start || midpoint >= end || !japanese) return []
    return [{ start: Math.max(0, from), end: to, japanese }]
  })
}
const timestamp = (seconds: number): string => {
  const ticks = Math.max(0, Math.round(seconds * 100))
  return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`
}
// Model output is text, never executable ASS overrides or subtitle file metadata.
const escapeAss = (value: string): string => value.replace(/\\/g, '\uFF3C').replace(/\{/g, '\uFF5B').replace(/\}/g, '\uFF5D').replace(/[\r\n]+/g, '\\N')
export function orderedCues(cues: SubtitleCue[]): SubtitleCue[] {
  const result: SubtitleCue[] = []
  for (const cue of [...cues].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1)
    if (previous && previous.japanese === cue.japanese && Math.abs(previous.start - cue.start) < 1 && cue.start < previous.end) {
      if (!previous.chinese && cue.chinese) previous.chinese = cue.chinese
      continue
    }
    result.push({ ...cue })
  }
  return result
}
export function renderSubtitleAss(cues: SubtitleCue[], display: SubtitleDisplay, fontSize = 42): string {
  const size = Math.max(20, Math.min(72, fontSize))
  const header = `[Script Info]\nTitle: AI 日中字幕\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,${size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,120,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
  return header + orderedCues(cues).map(cue => {
    const ja = escapeAss(cue.japanese), zh = cue.chinese ? escapeAss(cue.chinese) : null
    const text = display === 'japanese' ? ja : display === 'chinese' ? zh ?? ja
      : zh ? `${zh}\\N{\\fs${Math.round(size * 0.8)}}${ja}` : ja
    return `Dialogue: 0,${timestamp(cue.start)},${timestamp(cue.end)},Default,,0,0,0,,${text}\n`
  }).join('')
}
export function renderSubtitleSrt(cues: SubtitleCue[], display: SubtitleDisplay): string {
  const time = (seconds: number): string => {
    const milliseconds = Math.max(0, Math.round(seconds * 1000))
    return `${String(Math.floor(milliseconds / 3600000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`
  }
  return orderedCues(cues).map((cue, index) => {
    const ja = cue.japanese.replace(/[\r\n]+/g, ' '), zh = cue.chinese?.replace(/[\r\n]+/g, ' ')
    const text = display === 'japanese' ? ja : display === 'chinese' ? zh ?? ja : zh ? `${zh}\n${ja}` : ja
    return `${index + 1}\n${time(cue.start)} --> ${time(cue.end)}\n${text}\n`
  }).join('\n')
}
