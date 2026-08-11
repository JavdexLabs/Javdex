import { useState } from 'react'
import type { PlaylistCreateInput, PlaylistDetail, PlaylistUpdateInput } from '@shared/playlistTypes'
import { AppFormField } from './FormPrimitives'
import ImageImportField from './ImageImportField'
import Modal from './Modal'
import { useTheme } from './ThemeProvider'
import Button from './Button'

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

      size="md"
      confirmText={saving ? '保存中…' : editing ? '保存' : '创建'}
      confirmDisabled={!canSave || saving}
      onCancel={onCancel}
      onConfirm={() => void handleSave()}
    >
      <div className="form-grid playlist-form-grid">
        {!mediaEditorsHidden ? (
          <ImageImportField
            key={removeCover ? 'cover-removed' : 'cover-active'}
            label="封面"
            currentUrl={removeCover ? null : currentCoverUrl}
            onSourcePathChange={handleCoverChange}
            previewShape="square"
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
        ) : null}

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
