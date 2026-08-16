import { useState } from 'react'
import type { PlaylistCreateInput, PlaylistDetail, PlaylistUpdateInput } from '@shared/playlistTypes'
import EditFieldAiTranslate from './EditFieldAiTranslate'
import { EditFormField, EditFormSection } from './FormPrimitives'
import ImageImportField from './ImageImportField'
import Modal from './Modal'
import { useTheme } from './ThemeProvider'
import Button from './Button'
import RelatedLinksEditor, { relatedLinksFromDraft } from './RelatedLinksEditor'
import type { RelatedLinkInput } from '@shared/relatedLinkTypes'

interface Props {
  playlist?: PlaylistDetail
  currentCoverUrl?: string | null
  onCancel: () => void
  onCreate?: (input: PlaylistCreateInput) => Promise<void>
  onUpdate?: (input: PlaylistUpdateInput) => Promise<void>
}

export default function PlaylistCreateModal({
  playlist,
  currentCoverUrl = null,
  onCancel,
  onCreate,
  onUpdate
}: Props): JSX.Element {
  const { privacyMode } = useTheme()
  const editing = Boolean(playlist)
  const [name, setName] = useState(playlist?.name ?? '')
  const [description, setDescription] = useState(playlist?.description ?? '')
  const [coverSourcePath, setCoverSourcePath] = useState<string | null>(null)
  const [removeCover, setRemoveCover] = useState(false)
  const [links, setLinks] = useState<RelatedLinkInput[]>(
    playlist?.links.map(({ label, url }) => ({ label, url })) ?? []
  )
  const [saving, setSaving] = useState(false)
  const mediaEditorsHidden =
    privacyMode.privacyModeEnabled &&
    privacyMode.privacyModeScopes.includes('mediaEditors')

  const canSave = name.trim().length > 0

  const handleSave = async (): Promise<void> => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      const input = {
        name: name.trim(),
        description: description.trim() || null,
        links: relatedLinksFromDraft(links),
        ...(coverSourcePath && !mediaEditorsHidden ? { coverSourcePath } : {})
      }

      if (editing) {
        await onUpdate?.({ ...input, removeCover: mediaEditorsHidden ? false : removeCover })
      } else {
        await onCreate?.(input)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleCoverChange = (path: string | null): void => {
    setCoverSourcePath(path)
    if (path) setRemoveCover(false)
  }

  return (
    <Modal
      title={editing ? '编辑播放清单' : '创建播放清单'}
      size="lg"
      className="modal-entity-edit"
      confirmText={saving ? '保存中…' : editing ? '保存' : '创建'}
      confirmDisabled={!canSave || saving}
      onCancel={onCancel}
      onConfirm={() => void handleSave()}
    >
      <div className="entity-edit-form">
        {!mediaEditorsHidden ? (
          <EditFormSection title="封面" className="entity-edit-section--media">
            <ImageImportField
              key={removeCover ? 'cover-removed' : 'cover-active'}
              label="封面"
              hideLabel
              layout="inline"
              hint="从本地选择图片替换当前封面；保存后生效。支持 JPG、PNG、WebP。"
              currentUrl={removeCover ? null : currentCoverUrl}
              onSourcePathChange={handleCoverChange}
              extraActions={
                editing && playlist?.cover_path ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoveCover((value) => !value)}
                  >
                    {removeCover ? '撤销移除封面' : '移除当前封面'}
                  </Button>
                ) : undefined
              }
            />
          </EditFormSection>
        ) : null}

        <EditFormSection title="基本信息">
          <div className="entity-edit-fields">
            <EditFormField label="名称" htmlFor="playlist-name" span={2}>
              <input
                id="playlist-name"
                className="text-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="播放清单名称"
                autoFocus
              />
            </EditFormField>
            <EditFormField
              label="简介"
              htmlFor="playlist-description"
              span={2}
              labelExtra={
                <EditFieldAiTranslate
                  text={description}
                  disabled={saving}
                  onTranslated={setDescription}
                />
              }
            >
              <textarea
                id="playlist-description"
                className="text-input"
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </EditFormField>
          </div>
        </EditFormSection>

        <RelatedLinksEditor disabled={saving} links={links} onChange={setLinks} />
      </div>
    </Modal>
  )
}
