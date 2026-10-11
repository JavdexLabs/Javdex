import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OverlayHistoryProvider } from '../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'
import ExternalRatingsEditor from '../../apps/desktop/src/renderer/src/components/ExternalRatingsEditor'
import { createExternalRatingsDraft, externalRatingsDraftErrors, externalRatingsFromDraft } from '../../apps/desktop/src/renderer/src/components/externalRatingsDraft'
import Modal from '../../apps/desktop/src/renderer/src/components/Modal'
import { EditForm, EditFormField, EditFormSection } from '../../apps/desktop/src/renderer/src/components/FormPrimitives'
import TextInput from '../../apps/desktop/src/renderer/src/components/TextInput'
import Button from '../../apps/desktop/src/renderer/src/components/Button'
import RelatedLinksEditor from '../../apps/desktop/src/renderer/src/components/RelatedLinksEditor'

// Real production components with isolated synthetic metadata; no personal library access.
window.React = React
window.api = { organizations: { options: async () => [] }, directors: { options: async () => [] },
  series: { options: async () => [] } }
const { default: EditMetadataModal } = await import('../../apps/desktop/src/renderer/src/components/EditMetadataModal')
const query = new URLSearchParams(window.location.search)
applyTheme(query.get('theme') || 'slate')
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const initialRatings = query.has('single') ? [
  { id: 2, video_id: 1, source: 'JavDB', rating_average: 3.2, rating_count: 21, fetched_at: null, is_default: 1 }
] : [
  { id: 1, video_id: 1, source: 'JavLibrary', rating_average: 3.5, rating_count: null, fetched_at: null, is_default: 1 },
  { id: 2, video_id: 1, source: 'JavDB', rating_average: 4.3, rating_count: 176, fetched_at: null, is_default: 0 }
]

function Fixture() {
  const [open, setOpen] = useState(true)
  const [video, setVideo] = useState({ id: 1, code: 'HUBLK-078', title: '影片资料编辑示例', summary: '',
    release_date: null, maker: 'Hunter', publisher: 'HHHグループ', director: '', series: '', actresses: [],
    tags: [{ name: '标签 A', origin: 'scraped' }, { name: '标签 B', origin: 'scraped' }],
    external_stats: initialRatings, links: [], cover_path: null })
  const [draft, setDraft] = useState(() => createExternalRatingsDraft(initialRatings))
  const [links, setLinks] = useState([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(null)
  const [failed, setFailed] = useState(false)
  const save = async (input) => {
    setBusy(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (query.has('fail') && !failed) { setFailed(true); throw new Error('合成保存失败，草稿保留，可重试。') }
      if (input.externalRatings) {
        const { deletedSources, defaultSource, entries = [] } = input.externalRatings
        const edited = entries.map((entry) => entry.originalSource)
        const remaining = video.external_stats.filter((rating) => !deletedSources.includes(rating.source) && !edited.includes(rating.source))
        let nextId = Math.max(0, ...video.external_stats.map((rating) => rating.id)) + 1
        for (const entry of entries) {
          const previous = video.external_stats.find((rating) => rating.source === entry.originalSource)
          remaining.push({ id: previous?.id ?? nextId++, video_id: 1, source: entry.source,
            rating_average: entry.ratingAverage, rating_count: entry.ratingCount, fetched_at: previous?.fetched_at ?? null })
        }
        setVideo({ ...video, external_stats: remaining.map((rating) => ({ ...rating, is_default: rating.source === defaultSource ? 1 : 0 })) })
      }
      setSaved(input)
      setOpen(false)
    } finally { setBusy(false) }
  }
  return <>
    <main style={{ padding: 32 }}>
      <h2>外部评分 · 紧凑表格</h2>
      <Button onClick={() => { setDraft(createExternalRatingsDraft(video.external_stats)); setOpen(true) }}>重新编辑</Button>
      {saved && <><p>已保存合成资料</p><pre aria-label="保存结果">{JSON.stringify(saved.externalRatings, null, 2)}</pre></>}
    </main>
    {open && (query.get('view') === 'component' ?
      <Modal title="编辑影片资料" subtitle="HUBLK-078" size="xl" confirmText="保存" busy={busy}
        confirmDisabled={externalRatingsDraftErrors(draft).size > 0} onCancel={() => setOpen(false)}
        onConfirm={() => save({ externalRatings: externalRatingsFromDraft(draft) })}>
        <EditForm>
          <EditFormSection title="刮削标签"><EditFormField label="" hint="多个标签用逗号分隔；不影响自定义标签">
            <TextInput aria-label="刮削标签" defaultValue="标签 A, 标签 B" />
          </EditFormField></EditFormSection>
          <ExternalRatingsEditor value={draft} disabled={busy} onChange={setDraft} />
          <RelatedLinksEditor disabled={busy} links={links} onChange={setLinks} />
        </EditForm>
      </Modal> : <EditMetadataModal key={open.toString()} video={video} onCancel={() => setOpen(false)} onSave={save} />)}
  </>
}
const root = createRoot(document.getElementById('root'))
root.render(<QueryClientProvider client={client}><OverlayHistoryProvider><Fixture /></OverlayHistoryProvider></QueryClientProvider>)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
