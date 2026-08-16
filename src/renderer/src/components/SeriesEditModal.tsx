import { useDeferredValue, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import type {
  OrganizationSummary,
  SeriesDetail,
  SeriesSummary,
  SeriesUpdateInput
} from '@shared/classificationTypes'
import { api } from '../api'
import { organizationKeys, seriesKeys } from '../query/queryKeys'
import Modal from './Modal'
import SelectControl from './SelectControl'
import AliasTagEditor from './AliasTagEditor'
import EditFieldAiTranslate from './EditFieldAiTranslate'
import { EditFormField, EditFormSection } from './FormPrimitives'
import { createSeriesFormDraft, seriesInputFromDraft } from './seriesFormState'
import { promoteAliasToMain } from './aliasEditorState'
import { moveClassificationLink, useClassificationLinkKeys } from './classificationLinkForm'
import { UI_ICON_SM } from './iconDefaults'
import IconButton from './IconButton'
import Button from './Button'

interface Props {
  series?: SeriesDetail | null
  onCancel: () => void
  onSave: (input: SeriesUpdateInput) => Promise<void>
}

export default function SeriesEditModal({ series, onCancel, onSave }: Props): JSX.Element {
  const [draft, setDraft] = useState(() => createSeriesFormDraft(series))
  const { linkKeys, moveLinkKey, removeLinkKey, appendLinkKey } =
    useClassificationLinkKeys(draft.links.length)
  const [ownerSearch, setOwnerSearch] = useState(series?.ownerOrganization?.mainName ?? '')
  const [parentSearch, setParentSearch] = useState(series?.parentSeries?.mainName ?? '')
  const [selectedOwner, setSelectedOwner] = useState<OrganizationSummary | null>(
    series?.ownerOrganization ?? null
  )
  const [selectedParent, setSelectedParent] = useState<SeriesSummary | null>(
    series?.parentSeries ?? null
  )
  const [saving, setSaving] = useState(false)
  const deferredOwnerSearch = useDeferredValue(ownerSearch.trim())
  const deferredParentSearch = useDeferredValue(parentSearch.trim())
  const ownerQuery = useQuery({
    queryKey: organizationKeys.options(deferredOwnerSearch),
    queryFn: () => api.organizations.options(deferredOwnerSearch || undefined),
    placeholderData: (previous) => previous
  })
  const parentQuery = useQuery({
    queryKey: seriesKeys.options(deferredParentSearch),
    queryFn: () => api.series.options(deferredParentSearch || undefined),
    placeholderData: (previous) => previous
  })
  const ownerOptions = useMemo(() => {
    const options = ownerQuery.data ?? []
    if (!selectedOwner || options.some((item) => item.id === selectedOwner.id)) return options
    return [{ ...selectedOwner, aliases: [], roles: [] }, ...options]
  }, [ownerQuery.data, selectedOwner])
  const parentOptions = useMemo(() => {
    const options = (parentQuery.data ?? []).filter((item) => item.id !== series?.id)
    if (!selectedParent || options.some((item) => item.id === selectedParent.id)) return options
    return [{ ...selectedParent, aliases: [], videoCount: 0 }, ...options]
  }, [parentQuery.data, selectedParent, series?.id])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(seriesInputFromDraft(draft))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={series ? '编辑系列资料' : '新增系列'}

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
            <EditFormField label="主名" htmlFor="series-main-name" span={2}>
              <input
                id="series-main-name"
                className="text-input"
                autoFocus
                value={draft.mainName}
                onChange={(event) => setDraft({ ...draft, mainName: event.target.value })}
              />
            </EditFormField>
            <EditFormField
              label="别名"
              htmlFor="series-aliases"
              span={2}
              labelExtra={
                draft.aliases.length > 0 ? (
                  <span id="series-aliases-hint" className="entity-edit-label-note">
                    点击设为主名
                  </span>
                ) : undefined
              }
            >
              <AliasTagEditor
                id="series-aliases"
                aliases={draft.aliases}
                onChange={(aliases) => setDraft({ ...draft, aliases })}
                onPromoteToMain={(alias) =>
                  setDraft({ ...draft, ...promoteAliasToMain(draft.mainName, draft.aliases, alias) })
                }
                disabled={saving}
                aria-describedby={draft.aliases.length > 0 ? 'series-aliases-hint' : undefined}
              />
            </EditFormField>
            {series && draft.mainName.trim() !== series.mainName ? (
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
            <EditFormField
              label="简介"
              htmlFor="series-summary"
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
                id="series-summary"
                className="text-input"
                rows={5}
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              />
            </EditFormField>
          </div>
        </EditFormSection>

        <EditFormSection title="系列信息">
          <div className="entity-edit-fields">
            <EditFormField label="状态" htmlFor="series-status" span={2}>
              <SelectControl
                id="series-status"
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as typeof draft.status })
                }
              >
                <option value="unknown">未知</option>
                <option value="ongoing">连载中</option>
                <option value="completed">已完结</option>
                <option value="discontinued">已中止</option>
              </SelectControl>
            </EditFormField>
            <EditFormField label="开始年份" htmlFor="series-start-year">
              <input
                id="series-start-year"
                className="text-input"
                type="number"
                min="1"
                max="9999"
                value={draft.startYear}
                onChange={(event) => setDraft({ ...draft, startYear: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="结束年份" htmlFor="series-end-year">
              <input
                id="series-end-year"
                className="text-input"
                type="number"
                min="1"
                max="9999"
                value={draft.endYear}
                onChange={(event) => setDraft({ ...draft, endYear: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="所属机构" htmlFor="series-owner" span={2}>
              <div className="organization-parent-picker">
                <input
                  className="text-input"
                  value={ownerSearch}
                  aria-label="搜索所属机构"
                  placeholder="搜索机构主名或别名…"
                  onChange={(event) => setOwnerSearch(event.target.value)}
                />
                <SelectControl
                  id="series-owner"
                  value={draft.ownerOrganizationId}
                  onChange={(event) => {
                    const ownerOrganizationId = event.target.value
                    const option = ownerOptions.find(
                      (item) => String(item.id) === ownerOrganizationId
                    )
                    setSelectedOwner(option ? { id: option.id, mainName: option.mainName } : null)
                    setDraft({ ...draft, ownerOrganizationId })
                  }}
                >
                  <option value="">未归属</option>
                  {ownerOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.mainName}
                    </option>
                  ))}
                </SelectControl>
                <span className="entity-edit-field-hint">
                  所属机构只由手动选择设置，不会从影片制作商或发行商推断。
                </span>
                {ownerQuery.isError ? (
                  <span className="classification-picker-error" role="alert">
                    所属机构候选加载失败，请稍后重试。
                  </span>
                ) : null}
              </div>
            </EditFormField>
            <EditFormField label="上级系列" htmlFor="series-parent" span={2}>
              <div className="organization-parent-picker">
                <input
                  className="text-input"
                  value={parentSearch}
                  aria-label="搜索上级系列"
                  placeholder="搜索系列主名或别名…"
                  onChange={(event) => setParentSearch(event.target.value)}
                />
                <SelectControl
                  id="series-parent"
                  value={draft.parentSeriesId}
                  onChange={(event) => {
                    const parentSeriesId = event.target.value
                    const option = parentOptions.find((item) => String(item.id) === parentSeriesId)
                    setSelectedParent(option ?? null)
                    setDraft({ ...draft, parentSeriesId })
                  }}
                >
                  <option value="">无</option>
                  {parentOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.mainName} · {option.ownerOrganization?.mainName ?? '未归属'}
                    </option>
                  ))}
                </SelectControl>
                <span className="entity-edit-field-hint">层级循环会在保存时拒绝。</span>
                {parentQuery.isError ? (
                  <span className="classification-picker-error" role="alert">
                    上级系列候选加载失败，请稍后重试。
                  </span>
                ) : null}
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
                  aria-label={`链接 ${index + 1} 名称`}
                  placeholder="名称"
                  value={link.label}
                  onChange={(event) => {
                    const links = [...draft.links]
                    links[index] = { ...link, label: event.target.value }
                    setDraft({ ...draft, links })
                  }}
                />
                <input
                  className="text-input"
                  aria-label={`链接 ${index + 1} 地址`}
                  placeholder="https://"
                  value={link.url}
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
