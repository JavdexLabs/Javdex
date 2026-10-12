import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.api = {}
const [{ default: PlaylistCard }, { default: PlaylistCover }, { default: PlaylistPickerRow }, { default: Button }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/components/PlaylistCard'),
  import('../../apps/desktop/src/renderer/src/components/PlaylistCover'),
  import('../../apps/desktop/src/renderer/src/components/PlaylistPickerRow'),
  import('../../apps/desktop/src/renderer/src/components/Button')
])
applyTheme('graphite')
const lists = [
  { id: 1, name: '我喜欢', description: '保存喜欢的影片', system_kind: 'favorites', cover_path: null, preview_cover_path: null, video_count: 0, contains_video: false },
  { id: 2, name: '稍后观看', description: '留到下次观看', system_kind: 'watch_later', cover_path: null, preview_cover_path: null, video_count: 0, contains_video: false },
  { id: 0, name: '最近播放', description: '仅此设备 · 按最近一次播放倒序', local_kind: 'recently_played', cover_path: null, preview_cover_path: null, video_count: 0, contains_video: false }
]
function Fixture() {
  const [selected, setSelected] = useState(1)
  const [privacy, setPrivacy] = useState(false)
  return <main style={{ padding: 24, maxWidth: 1000, margin: '0 auto', display: 'grid', gap: 24,
    height: '100vh', overflow: 'auto', scrollbarGutter: 'stable', boxSizing: 'border-box', alignContent: 'start' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <h1 style={{ fontSize: 18, margin: 0, marginRight: 'auto' }}>清单默认封面</h1>
      <Button variant="ghost" onClick={() => applyTheme('graphite')}>深色</Button>
      <Button variant="ghost" onClick={() => applyTheme('light')}>浅色</Button>
      <Button variant="ghost" onClick={() => {
        document.documentElement.dataset.privacyMode = String(!privacy)
        document.documentElement.dataset.privacyCovers = String(!privacy)
        setPrivacy(!privacy)
      }}>隐私模式：{privacy ? '开' : '关'}</Button>
    </header>
    <section><h2 style={{ fontSize: 14 }}>清单列表 · 82px</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        {lists.map(item => <PlaylistCard key={item.id} item={item} active={selected === item.id} onOpen={() => setSelected(item.id)} />)}
      </div>
    </section>
    <section><h2 style={{ fontSize: 14 }}>详情封面 · 164px</h2>
      <div style={{ display: 'flex', gap: 24 }}>
        {lists.map(item => <div key={item.id}><PlaylistCover variant="detail" playlist={item} /><p>{item.name}</p></div>)}
      </div>
    </section>
    <section><h2 style={{ fontSize: 14 }}>清单选择器 · 68px</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        {lists.map(item => <PlaylistPickerRow key={item.id} item={item} selected={selected === item.id} onSelect={() => setSelected(item.id)} />)}
      </div>
    </section>
  </main>
}
const root = createRoot(document.getElementById('root'))
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
root.render(<Fixture />)
