import type { SubtitleCue } from './subtitleDocument'

export type SubtitleLogWriter = (stage: string, value: unknown) => void
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const time = (seconds: number): string => new Date(Math.max(0, seconds) * 1000).toISOString().slice(11, 23)

/** Bounded, session-local diagnostics; never forwarded through status events. */
export function createSubtitleLog(limit = 1024 * 1024) {
  const entries: string[] = []
  let length = 0, dropped = 0
  let cues: SubtitleCue[] = [], error: string | null = null
  const write: SubtitleLogWriter = (stage, value) => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const cap = Math.min(64 * 1024, Math.floor(limit / 2))
    const content = raw.length > cap ? `${raw.slice(0, cap)}\n[本条日志已截断]` : raw
    const entry = `[${new Date().toISOString()}] ${stage}\n${content}\n\n`
    entries.push(entry); length += entry.length
    while (length > limit && entries.length > 1) { length -= entries.shift()!.length; dropped++ }
  }
  return {
    write,
    update(value: SubtitleCue[], failure: string | null): void {
      cues = value.slice(-500).map(cue => ({ ...cue, japanese: cue.japanese.slice(0, 6000), chinese: cue.chinese?.slice(0, 6000) }))
      error = failure
    },
    html(): string {
      const rows = cues.map(cue => `<article><header>${time(cue.start)} — ${time(cue.end)}</header><div class="pair"><section><label>识别原文 · 日语</label><p>${escapeHtml(cue.japanese)}</p></section><section><label>翻译结果 · 中文</label><p>${cue.chinese ? escapeHtml(cue.chinese) : '<span class="muted">尚未完成翻译</span>'}</p></section></div></article>`).join('')
      return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>AI 字幕 · 识别与翻译</title><style>
      :root{color-scheme:light dark;font-family:system-ui,sans-serif;background:light-dark(#f4f5f7,#101316);color:light-dark(#202731,#dfe5eb)}body{max-width:1100px;margin:32px auto;padding:0 24px}h1{font-size:24px;margin-bottom:8px}.muted,label,header{color:light-dark(#647080,#9aa7b4)}article,details{border:1px solid light-dark(#d5dce4,#343e49);border-radius:10px;margin:12px 0;background:light-dark(#fff,#191e24)}header{padding:12px 16px;border-bottom:1px solid light-dark(#e5e9ee,#303840);font-variant-numeric:tabular-nums;font-size:13px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:16px}label{font-size:12px}p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;margin:8px 0 0}details{padding:16px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:600px;overflow:auto}.error{color:light-dark(#b32939,#f38b95)}@media(max-width:640px){.pair{grid-template-columns:1fr}}
      </style><h1>AI 字幕 · 识别与翻译</h1><p class="muted">本机快照 · ${escapeHtml(new Date().toLocaleString('zh-CN'))} · 最多展示最近 500 条字幕。再次点击播放器的“查看日志”可更新。</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}${rows || '<p class="muted">暂无识别结果，开启 AI 字幕后等待生成。</p>'}<details><summary>原始诊断日志${dropped ? `（已淘汰 ${dropped} 条较早记录）` : ''}</summary><pre>${escapeHtml(entries.join('') || '暂无推理记录。')}</pre></details></html>`
    },
    text: (): string => `AI 字幕日志（本机快照，重新打开可刷新）\n${dropped ? `已淘汰 ${dropped} 条较早日志。\n` : ''}\n${entries.join('') || '暂无推理记录。开启 AI 字幕后生成；缓存命中不会重新调用模型。\n'}`,
    clear(): void { entries.length = 0; length = 0; dropped = 0; cues = []; error = null }
  }
}
