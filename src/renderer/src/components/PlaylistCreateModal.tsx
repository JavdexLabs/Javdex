import { useState } from 'react'
import type { PlaylistCreateInput, PlaylistDetail, PlaylistUpdateInput } from '@shared/types'
import { AppFormField } from './FormPrimitives'
import ImageImportField from './ImageImportField'
import Modal from './Modal'

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
  const editing = Boolean(playlist)
  const [name, setName] = useState(playlist?.name ?? '')
  const [description, setDescription] = useState(playlist?.description ?? '')
  const [coverSourcePath, setCoverSourcePath] = useState<string | null>(null)
  const [removeCover, setRemoveCover] = useState(false)
  const [saving, setSaving] = useState(false)

  const canSave = name.trim().length > 0

  const handleSave = async (): Promise<void> => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      const input = {
        name: name.trim(),
        description: description.trim() || null,
        ...(coverSourcePath ? { coverSourcePath } : {})
      }

      if (editing) {
        await onUpdate?.({ ...input, removeCover })
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
      size="md"
      confirmText={saving ? '保存中…' : editing ? '保存' : '创建'}
      confirmDisabled={!canSave || saving}
      onCancel={onCancel}
      onConfirm={() => void handleSave()}
    >
      <div className="form-grid playlist-form-grid">
        <ImageImportField
          key={removeCover ? 'cover-removed' : 'cover-active'}
          label="封面"
          currentUrl={removeCover ? null : currentCoverUrl}
          onSourcePathChange={handleCoverChange}
          previewShape="square"
          extraActions={
            editing && playlist?.cover_path ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setRemoveCover((value) => !value)}
              >
                {removeCover ? '撤销移除封面' : '移除当前封面'}
              </button>
            ) : undefined
          }
        />

        <AppFormField label="名称">
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="播放清单名称"
            autoFocus
          />
        </AppFormField>

        <AppFormField label="简介" className="playlist-form-description">
          <textarea
            className="text-input"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </AppFormField>
      </div>
    </Modal>
  )
}
