import { useMemo, useState } from 'react'
import { isIsoDate, toDateInputValue, actressMergeGenderGroup } from '@shared/actressProfileOptions'
import type { Actress, VideoDetail, VideoEditInput } from '@shared/types'
import { assetUrl } from '../api'
import EditFieldAiTranslate from './EditFieldAiTranslate'
import { EditFormField, EditFormSection } from './FormPrimitives'
import ImageImportField from './ImageImportField'
import Modal from './Modal'

interface Props {
  video: VideoDetail
  onCancel: () => void
  onSave: (input: VideoEditInput) => Promise<void>
}

function castNamesByGender(actresses: Actress[], gender: 'female' | 'male'): string {
  return actresses
    .filter((item) => actressMergeGenderGroup(item.gender) === gender)
    .map((item) => item.main_name)
    .join(', ')
}

/** Modal form for manually editing a video's metadata. */
export default function EditMetadataModal({ video, onCancel, onSave }: Props): JSX.Element {
  const [title, setTitle] = useState(video.title ?? '')
  const [releaseDate, setReleaseDate] = useState(toDateInputValue(video.release_date))
  const [director, setDirector] = useState(video.director ?? '')
  const [maker, setMaker] = useState(video.maker ?? '')
  const [publisher, setPublisher] = useState(video.publisher ?? '')
  const [series, setSeries] = useState(video.series ?? '')
  const [summary, setSummary] = useState(video.summary ?? '')
  const [tags, setTags] = useState(
    video.tags
      .filter((t) => t.origin === 'scraped')
      .map((t) => t.name)
      .join(', ')
  )
  const initialActressesFemale = useMemo(
    () => castNamesByGender(video.actresses, 'female'),
    [video.actresses]
  )
  const initialActressesMale = useMemo(
    () => castNamesByGender(video.actresses, 'male'),
    [video.actresses]
  )
  const [actressesFemale, setActressesFemale] = useState(initialActressesFemale)
  const [actressesMale, setActressesMale] = useState(initialActressesMale)
  const [coverSourcePath, setCoverSourcePath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const splitList = (s: string): string[] =>
    s
      .split(/[,，、]/)
      .map((x) => x.trim())
      .filter(Boolean)

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        title: title.trim() || null,
        release_date: releaseDate.trim() || null,
        maker: maker.trim() || null,
        publisher: publisher.trim() || null,
        series: series.trim() || null,
        director: director.trim() || null,
        summary: summary.trim() || null,
        tags: splitList(tags),
        actressesFemale: splitList(actressesFemale),
        actressesMale: splitList(actressesMale),
        ...(coverSourcePath ? { coverSourcePath } : {})
      })
    } finally {
      setSaving(false)
    }
  }

  const displayTitle = title.trim() || video.title?.trim() || video.code
  const releaseDateInvalid = releaseDate !== '' && !isIsoDate(releaseDate)

  return (
    <Modal
      title="编辑影片资料"
      subtitle={video.code}
      size="xl"
      className="modal-entity-edit"
      confirmText={saving ? '保存中…' : '保存'}
      confirmDisabled={saving || releaseDateInvalid}
      onCancel={onCancel}
      onConfirm={() => void handleSave()}
    >
      <div className="entity-edit-form">
        <EditFormSection title="封面" className="entity-edit-section--media">
          <ImageImportField
            label="封面"
            hideLabel
            layout="inline"
            hint="从本地选择图片替换当前封面；保存后生效。支持 JPG、PNG、WebP。"
            currentUrl={assetUrl(video.cover_path)}
            onSourcePathChange={setCoverSourcePath}
          />
        </EditFormSection>

        <EditFormSection title="基本信息">
          <div className="entity-edit-fields">
            <EditFormField
              label="标题"
              htmlFor="video-edit-title"
              span={2}
              labelExtra={
                <EditFieldAiTranslate text={title} disabled={saving} onTranslated={setTitle} />
              }
            >
              <input
                id="video-edit-title"
                className="text-input"
                value={title}
                placeholder={displayTitle}
                onChange={(e) => setTitle(e.target.value)}
              />
            </EditFormField>

            <EditFormField label="发行日期" htmlFor="video-edit-release-date">
              <input
                id="video-edit-release-date"
                className="text-input"
                type="date"
                value={releaseDate}
                onChange={(e) => setReleaseDate(e.target.value)}
              />
            </EditFormField>

            <EditFormField label="导演" htmlFor="video-edit-director">
              <input
                id="video-edit-director"
                className="text-input"
                value={director}
                onChange={(e) => setDirector(e.target.value)}
              />
            </EditFormField>

            <EditFormField
              label="剧情简介"
              htmlFor="video-edit-summary"
              span={2}
              labelExtra={
                <EditFieldAiTranslate text={summary} disabled={saving} onTranslated={setSummary} />
              }
            >
              <textarea
                id="video-edit-summary"
                className="text-input"
                rows={4}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </EditFormField>
          </div>
        </EditFormSection>

        <EditFormSection title="出品信息">
          <div className="entity-edit-fields">
            <EditFormField label="制作商" htmlFor="video-edit-maker">
              <input
                id="video-edit-maker"
                className="text-input"
                value={maker}
                onChange={(e) => setMaker(e.target.value)}
              />
            </EditFormField>

            <EditFormField label="发行商" htmlFor="video-edit-publisher">
              <input
                id="video-edit-publisher"
                className="text-input"
                value={publisher}
                onChange={(e) => setPublisher(e.target.value)}
              />
            </EditFormField>

            <EditFormField label="系列" htmlFor="video-edit-series" span={2}>
              <input
                id="video-edit-series"
                className="text-input"
                value={series}
                onChange={(e) => setSeries(e.target.value)}
              />
            </EditFormField>
          </div>
        </EditFormSection>

        <EditFormSection title="演职员与标签">
          <div className="entity-edit-fields">
            <EditFormField
              label="女优"
              htmlFor="video-edit-actresses-female"
              hint="多个演员用逗号分隔"
            >
              <input
                id="video-edit-actresses-female"
                className="text-input"
                value={actressesFemale}
                onChange={(e) => setActressesFemale(e.target.value)}
              />
            </EditFormField>

            <EditFormField
              label="男优"
              htmlFor="video-edit-actresses-male"
              hint="多个演员用逗号分隔"
            >
              <input
                id="video-edit-actresses-male"
                className="text-input"
                value={actressesMale}
                onChange={(e) => setActressesMale(e.target.value)}
              />
            </EditFormField>

            <EditFormField
              label="刮削标签"
              htmlFor="video-edit-tags"
              span={2}
              hint="多个标签用逗号分隔；不影响自定义标签"
            >
              <input
                id="video-edit-tags"
                className="text-input"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </EditFormField>
          </div>
        </EditFormSection>
      </div>
    </Modal>
  )
}
