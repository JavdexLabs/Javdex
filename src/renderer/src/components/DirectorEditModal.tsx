import { useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import type { DirectorDetail, DirectorUpdateInput } from '@shared/classificationTypes'
import Modal from './Modal'
import SelectControl from './SelectControl'
import AliasTagEditor from './AliasTagEditor'
import EditFieldAiTranslate from './EditFieldAiTranslate'
import { EditFormField, EditFormSection } from './FormPrimitives'
import { createDirectorFormDraft, directorInputFromDraft } from './directorFormState'
import { promoteAliasToMain } from './aliasEditorState'
import { UI_ICON_SM } from './iconDefaults'
import IconButton from './IconButton'
import { moveClassificationLink, useClassificationLinkKeys } from './classificationLinkForm'
import Button from './Button'

interface Props {
  director?: DirectorDetail | null
  onCancel: () => void
  onSave: (input: DirectorUpdateInput) => Promise<void>
}

export default function DirectorEditModal({ director, onCancel, onSave }: Props): JSX.Element {
  const [draft, setDraft] = useState(() => createDirectorFormDraft(director))
  const { linkKeys, moveLinkKey, removeLinkKey, appendLinkKey } =
    useClassificationLinkKeys(draft.links.length)
  const [saving, setSaving] = useState(false)
  const field = (key: keyof typeof draft, value: string): void =>
    setDraft({ ...draft, [key]: value })
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(directorInputFromDraft(draft))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title={director ? '编辑导演资料' : '新增导演'}

      size="lg"
      className="modal-entity-edit"
      confirmText={saving ? '保存中…' : '保存'}
      confirmDisabled={saving || !draft.mainName.trim()}
      onCancel={onCancel}
      onConfirm={() => void save()}
    >
      <div className="entity-edit-form">
        <EditFormSection title="名称与简介">
          <div className="entity-edit-fields">
            <EditFormField label="主名" htmlFor="director-main-name" span={2}>
              <input
                id="director-main-name"
                className="text-input"
                autoFocus
                value={draft.mainName}
                onChange={(e) => field('mainName', e.target.value)}
              />
            </EditFormField>
            <EditFormField
              label="别名"
              htmlFor="director-aliases"
              span={2}
              labelExtra={
                draft.aliases.length > 0 ? (
                  <span id="director-aliases-hint" className="entity-edit-label-note">
                    点击设为主名
                  </span>
                ) : undefined
              }
            >
              <AliasTagEditor
                id="director-aliases"
                aliases={draft.aliases}
                onChange={(aliases) => setDraft({ ...draft, aliases })}
                onPromoteToMain={(alias) => setDraft({ ...draft, ...promoteAliasToMain(draft.mainName, draft.aliases, alias) })}
                disabled={saving}
                aria-describedby={draft.aliases.length > 0 ? 'director-aliases-hint' : undefined}
              />
            </EditFormField>
            {director && draft.mainName.trim() !== director.mainName ? (
              <label className="check-row entity-edit-field--full">
                <input
                  type="checkbox"
                  checked={draft.keepPreviousMainName}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      keepPreviousMainName: e.target.checked,
                    })
                  }
                />
                将旧主名保留为别名
              </label>
            ) : null}
            <EditFormField
              label="简介"
              htmlFor="director-summary"
              span={2}
              labelExtra={
                <EditFieldAiTranslate
                  text={draft.summary}
                  disabled={saving}
                  onTranslated={(summary) => setDraft({ ...draft, summary })}
                />
              }
            >
              <textarea
                id="director-summary"
                className="text-input"
                rows={5}
                value={draft.summary}
                onChange={(e) => field('summary', e.target.value)}
              />
            </EditFormField>
          </div>
        </EditFormSection>
        <EditFormSection title="履历">
          <div className="entity-edit-fields">
            <EditFormField label="国家或地区" htmlFor="director-country">
              <input
                id="director-country"
                className="text-input"
                value={draft.countryRegion}
                onChange={(e) => field('countryRegion', e.target.value)}
              />
            </EditFormField>
            <EditFormField label="出生地" htmlFor="director-birth-place">
              <input
                id="director-birth-place"
                className="text-input"
                value={draft.birthPlace}
                onChange={(e) => field('birthPlace', e.target.value)}
              />
            </EditFormField>
            <EditFormField label="出生日期" htmlFor="director-birth-date">
              <input
                id="director-birth-date"
                className="text-input"
                type="date"
                value={draft.birthDate}
                onChange={(e) => field('birthDate', e.target.value)}
              />
            </EditFormField>
            <EditFormField label="去世日期" htmlFor="director-death-date">
              <input
                id="director-death-date"
                className="text-input"
                type="date"
                value={draft.deathDate}
                onChange={(e) => field('deathDate', e.target.value)}
              />
            </EditFormField>
            <EditFormField label="从业开始" htmlFor="director-career-start">
              <input
                id="director-career-start"
                className="text-input"
                type="number"
                min="1"
                max="9999"
                value={draft.careerStartYear}
                onChange={(e) => field('careerStartYear', e.target.value)}
              />
            </EditFormField>
            <EditFormField label="从业结束" htmlFor="director-career-end">
              <input
                id="director-career-end"
                className="text-input"
                type="number"
                min="1"
                max="9999"
                value={draft.careerEndYear}
                onChange={(e) => field('careerEndYear', e.target.value)}
              />
            </EditFormField>
            <EditFormField label="状态" htmlFor="director-status">
              <SelectControl
                id="director-status"
                value={draft.status}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    status: e.target.value as typeof draft.status,
                  })
                }
              >
                <option value="unknown">未知</option>
                <option value="active">活跃</option>
                <option value="paused">暂停</option>
                <option value="retired">已退休</option>
                <option value="deceased">已故</option>
              </SelectControl>
            </EditFormField>
          </div>
        </EditFormSection>
        <EditFormSection title="相关链接">
          <div className="organization-link-editor">
            {draft.links.map((link, index) => (
              <div className="organization-link-editor-row" key={linkKeys[index]}>
                <input
                  className="text-input"
                  aria-label={`链接 ${index + 1} 名称`}
                  placeholder="名称"
                  value={link.label}
                  onChange={(e) => {
                    const links = [...draft.links]
                    links[index] = { ...link, label: e.target.value }
                    setDraft({ ...draft, links })
                  }}
                />
                <input
                  className="text-input"
                  aria-label={`链接 ${index + 1} 地址`}
                  placeholder="https://"
                  value={link.url}
                  onChange={(e) => {
                    const links = [...draft.links]
                    links[index] = { ...link, url: e.target.value }
                    setDraft({ ...draft, links })
                  }}
                />
                <div className="organization-link-actions">
                  <IconButton
                    className="organization-link-action"
                    icon={<ChevronUp {...UI_ICON_SM} aria-hidden />}
                    label={`上移链接 ${index + 1}`}
                    disabled={index === 0}
                    onClick={() => {
                      setDraft({
                        ...draft,
                        links: moveClassificationLink(draft.links, index, index - 1)
                      })
                      moveLinkKey(index, index - 1)
                    }}
                  />
                  <IconButton
                    className="organization-link-action"
                    icon={<ChevronDown {...UI_ICON_SM} aria-hidden />}
                    label={`下移链接 ${index + 1}`}
                    disabled={index === draft.links.length - 1}
                    onClick={() => {
                      setDraft({
                        ...draft,
                        links: moveClassificationLink(draft.links, index, index + 1)
                      })
                      moveLinkKey(index, index + 1)
                    }}
                  />
                  <IconButton
                    className="organization-link-action"
                    tone="danger"
                    icon={<Trash2 {...UI_ICON_SM} aria-hidden />}
                    label={`删除链接 ${index + 1}`}
                    onClick={() => {
                      setDraft({
                        ...draft,
                        links: draft.links.filter((_, i) => i !== index)
                      })
                      removeLinkKey(index)
                    }}
                  />
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"

              size="sm"
              className="organization-link-add"
              onClick={() => {
                setDraft({
                  ...draft,
                  links: [...draft.links, { label: '', url: '' }],
                })
                appendLinkKey()
              }}
            >
              <Plus {...UI_ICON_SM} />
              添加链接
            </Button>
          </div>
        </EditFormSection>
      </div>
    </Modal>
  )
}
