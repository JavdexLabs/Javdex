const api = window.playerProbe
const element = (id) => document.getElementById(id)
const bounds = () => {
  const { x, y, width, height } = element('viewport').getBoundingClientRect()
  return { x, y, width, height }
}
let state = {}
let dragging = false
const act = async (action, value) => {
  try { await api.action(action, value) } catch (error) { element('status').textContent = error.message }
}
element('source').addEventListener('change', async (event) => {
  try { await api.source(event.target.value) } catch (error) { element('status').textContent = error.message }
})
element('play').onclick = () => act('pause', !state.pause)
element('back').onclick = () => act('relative-seek', -5)
element('forward').onclick = () => act('relative-seek', 5)
element('fullscreen').onclick = () => act('fullscreen')
element('reopen').onclick = () => act('reopen')
element('volume').oninput = (event) => act('volume', Number(event.target.value))
element('seek').oninput = () => { dragging = true }
element('seek').onchange = async (event) => { await act('seek', Number(event.target.value)); dragging = false }
element('overlay').onclick = async () => { await api.overlay(true); element('dialog').showModal() }
async function dismiss() { element('dialog').close(); await api.overlay(false) }
element('dismiss').onclick = dismiss
element('dialog').addEventListener('cancel', (event) => { event.preventDefault(); void dismiss() })
window.addEventListener('keydown', (event) => {
  if (event.target.matches('input,select') || element('dialog').open) return
  if (event.code === 'Space') { event.preventDefault(); void act('pause', !state.pause) }
  if (event.code === 'ArrowLeft') void act('relative-seek', -5)
  if (event.code === 'ArrowRight') void act('relative-seek', 5)
  if (event.code === 'Escape') void act('exit-fullscreen')
})
api.onState((next) => {
  state = next
  const position = next['time-pos'] ?? 0, duration = next.duration ?? 0
  element('play').textContent = next.pause ? '播放' : '暂停'
  element('time').textContent = `${position.toFixed(1)} / ${duration.toFixed(1)} 秒`
  element('seek').max = duration || 18
  if (!dragging) element('seek').value = position
  element('status').textContent = [
    `画面 ${next.width ?? '—'}×${next.height ?? '—'} · ${next['video-codec'] ?? '—'} · 硬解 ${next['hwdec-current'] ?? '—'} · 原生绘制 ${next.nativeFrames ?? 0} 帧 · 渲染区 ${next.pixelWidth ?? 0}×${next.pixelHeight ?? 0}`,
    `音频 ${next['audio-codec'] ?? '—'} · 输出 ${next['current-ao'] ?? '—'} · 音频时钟 ${(next['audio-pts'] ?? 0).toFixed(2)} · 音量 ${next.volume ?? 15}% · 来源 ${next.source ?? '—'}`,
    `远程请求 ${next.remote?.requests ?? 0} · Range ${next.remote?.rangeRequests ?? 0} · 已发送 ${next.remote?.bytesSent ?? 0} 字节 · ${next.error || '运行正常'}`
  ].join('\n')
})
void api.initialize(bounds()).then(() => {
  new ResizeObserver(() => { void api.bounds(bounds()) }).observe(element('viewport'))
}).catch((error) => { element('status').textContent = error.message })
