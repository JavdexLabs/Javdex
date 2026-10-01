import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
const longError = '分类主图保存失败：请检查服务端连接；路径 /fixture/很长的中文分类主图目录/暂时不可用，请保留草稿后重试。\n'.repeat(40) + '错误详情末尾：所有诊断内容必须可滚达。'
let saves = 0
window.api = {
  assets: { getPathForFile: () => '/fixture/selected.png' },
  classificationImages: {
    set: async (_entity, input) => {
      if (++saves === 1) throw new Error(longError)
      return { imagePath: input.filePath, cleanupFailures: [] }
    }
  }
}
const { default: PosterCard } = await import('../../apps/desktop/src/renderer/src/components/PosterCard')
const { default: ClassificationImageModal } = await import('../../apps/desktop/src/renderer/src/components/ClassificationImageModal')

function PosterRemovalFixture() {
  const [removed, setRemoved] = useState(false)
  const location = useLocation()
  const video = { id: 1, code: 'P2-001', title: '清单影片', cover_path: null, scraped_status: 1 }
  return <main style={{ padding: 24 }}>
    <div style={{ width: 200, height: 340 }}>
      <PosterCard video={video} onRemove={() => setRemoved(true)} />
    </div>
    <p role="status" aria-label="移出反馈">{removed ? '已请求从清单移出' : '尚未请求移出'}</p>
    <output aria-label="当前路由">{location.pathname}</output>
  </main>
}

function ClassificationImageFixture() {
  const [open, setOpen] = useState(true)
  return open ? <ClassificationImageModal entity={{ kind: 'director', id: 1 }} entityLabel="导演"
    imagePath={null} fallbackCoverPath={null} onChanged={() => {}} onCancel={() => setOpen(false)} />
    : <p role="status">主图保存完成</p>
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/playlists/1']}>
    {new URLSearchParams(location.search).get('scenario') === 'classificationImage'
      ? <ClassificationImageFixture /> : <PosterRemovalFixture />}
  </MemoryRouter>
)
