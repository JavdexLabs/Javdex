import { useDeferredValue, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import type {
  OrganizationDetail,
  OrganizationSummary,
  OrganizationRole,
  OrganizationUpdateInput
} from '@shared/classificationTypes'
import { api } from '../api'
import { organizationKeys } from '../query/queryKeys'
import Modal from './Modal'
import { EditFormField, EditFormSection } from './FormPrimitives'
import {
  createOrganizationFormDraft,
  organizationUpdateInputFromDraft,
  retainSelectedParentOption
} from './organizationFormState'
import { moveClassificationLink, useClassificationLinkKeys } from './classificationLinkForm'
import { UI_ICON_SM } from './iconDefaults'
import IconButton from './IconButton'
import { FACET_LABEL } from '../facet'
import Button from './Button'

interface Props {
  role: OrganizationRole
  organization?: OrganizationDetail | null
  onCancel: () => void
  onSave: (input: OrganizationUpdateInput) => Promise<void>
}

export default function OrganizationEditModal({
  role,
  organization,
  onCancel,
  onSave
}: Props): JSX.Element {
  const [draft, setDraft] = useState(() => createOrganizationFormDraft(organization))
  const { linkKeys, moveLinkKey, removeLinkKey, appendLinkKey } =
    useClassificationLinkKeys(draft.links.length)
  const [parentSearch, setParentSearch] = useState(organization?.parent?.mainName ?? '')
  const [selectedParent, setSelectedParent] = useState<OrganizationSummary | null>(
    organization?.parent ?? null
  )
  const [saving, setSaving] = useState(false)
  const isEditing = Boolean(organization)
  const deferredParentSearch = useDeferredValue(parentSearch.trim())
  const parentOptionsQuery = useQuery({
    queryKey: organizationKeys.options(deferredParentSearch),
    queryFn: () => api.organizations.options(deferredParentSearch || undefined),
    placeholderData: (previous) => previous
  })
  const parentOptions = useMemo(() => {
    return retainSelectedParentOption(
      parentOptionsQuery.data ?? [],
      selectedParent,
      organization?.id
    )
  }, [organization?.id, parentOptionsQuery.data, selectedParent])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(organizationUpdateInputFromDraft(draft))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={isEditing ? '编辑机构资料' : `新增${FACET_LABEL[role]}`}

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
            <EditFormField label="主名" htmlFor="organization-main-name">
              <input
                id="organization-main-name"
                className="text-input"
                value={draft.mainName}
                autoFocus
                onChange={(event) => setDraft({ ...draft, mainName: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="别名" htmlFor="organization-aliases" hint="每行一个，也可用逗号分隔">
              <textarea
                id="organization-aliases"
                className="text-input"
                rows={3}
                value={draft.aliases}
                onChange={(event) => setDraft({ ...draft, aliases: event.target.value })}
              />
            </EditFormField>
            {isEditing && draft.mainName.trim() !== organization?.mainName ? (
              <label className="check-row entity-edit-field--full">
                <input
                  type="checkbox"
                  checked={draft.keepPreviousMainName}
                  onChange={(event) =>
                    setDraft({ ...draft, keepPreviousMainName: event.target.checked })
                  }
                />
                <span>将旧主名保留为别名</span>
              </label>
            ) : null}
            <EditFormField label="简介" htmlFor="organization-summary" span={2}>
              <textarea
                id="organization-summary"
                className="text-input"
                rows={5}
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              />
            </EditFormField>
          </div>
        </EditFormSection>

        <EditFormSection title="机构信息">
          <div className="entity-edit-fields">
            <EditFormField label="国家或地区" htmlFor="organization-country">
              <input
                id="organization-country"
                className="text-input"
                value={draft.countryRegion}
                onChange={(event) => setDraft({ ...draft, countryRegion: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="状态" htmlFor="organization-status">
              <select
                id="organization-status"
                className="select"
                value={draft.status}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    status: event.target.value as typeof draft.status
                  })
                }
              >
                <option value="unknown">未知</option>
                <option value="active">运营中</option>
                <option value="inactive">已停止</option>
              </select>
            </EditFormField>
            <EditFormField label="成立年份" htmlFor="organization-founded-year">
              <input
                id="organization-founded-year"
                className="text-input"
                inputMode="numeric"
                value={draft.foundedYear}
                onChange={(event) => setDraft({ ...draft, foundedYear: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="停止年份" htmlFor="organization-ended-year">
              <input
                id="organization-ended-year"
                className="text-input"
                inputMode="numeric"
                value={draft.endedYear}
                onChange={(event) => setDraft({ ...draft, endedYear: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="上级机构" htmlFor="organization-parent" span={2}>
              <div className="organization-parent-picker">
                <input
                  className="text-input"
                  value={parentSearch}
                  aria-label="搜索上级机构"
                  placeholder="搜索机构主名或别名…"
                  onChange={(event) => setParentSearch(event.target.value)}
                />
                <select
                  id="organization-parent"
                  className="select"
                  value={draft.parentOrganizationId}
                  onChange={(event) => {
                    const parentOrganizationId = event.target.value
                    const option = parentOptions.find(
                      (item) => String(item.id) === parentOrganizationId
                    )
                    setSelectedParent(
                      option ? { id: option.id, mainName: option.mainName } : null
                    )
                    setDraft({ ...draft, parentOrganizationId })
                  }}
                >
                  <option value="">无</option>
                  {parentOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.mainName}
                    </option>
                  ))}
                </select>
                <span className="entity-edit-field-hint">
                  {parentOptionsQuery.isError
                    ? '上级机构搜索失败，请重试。'
                    : '先搜索，再从结果中选择；层级循环会在保存时拒绝。'}
                </span>
              </div>
            </EditFormField>
          </div>
        </EditFormSection>

        <EditFormSection title="相关链接">
          <div className="organization-link-editor">
            {draft.links.map((link, index) => (
              <div className="organization-link-editor-row" key={linkKeys[index]}>
                <input
                  className="text-input"
                  value={link.label}
                  aria-label={`链接 ${index + 1} 名称`}
                  placeholder="名称"
                  onChange={(event) => {
                    const links = [...draft.links]
                    links[index] = { ...link, label: event.target.value }
                    setDraft({ ...draft, links })
                  }}
                />
                <input
                  className="text-input"
                  value={link.url}
                  aria-label={`链接 ${index + 1} 地址`}
                  placeholder="https://"
                  onChange={(event) => {
                    const links = [...draft.links]
                    links[index] = { ...link, url: event.target.value }
                    setDraft({ ...draft, links })
                  }}
                />
                <div className="organization-link-actions">
                  <IconButton
                    className="organization-link-action"
                    label={`上移链接 ${index + 1}`}
                    icon={<ChevronUp {...UI_ICON_SM} aria-hidden />}
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
                    label={`下移链接 ${index + 1}`}
                    icon={<ChevronDown {...UI_ICON_SM} aria-hidden />}
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
                    label={`移除链接 ${index + 1}`}
                    icon={<Trash2 {...UI_ICON_SM} aria-hidden />}
                    onClick={() => {
                      setDraft({
                        ...draft,
                        links: draft.links.filter((_, itemIndex) => itemIndex !== index)
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
                setDraft({ ...draft, links: [...draft.links, { label: '', url: '' }] })
                appendLinkKey()
              }}
            >
              <Plus {...UI_ICON_SM} aria-hidden />
              添加链接
            </Button>
          </div>
        </EditFormSection>
      </div>
    </Modal>
  )
}
