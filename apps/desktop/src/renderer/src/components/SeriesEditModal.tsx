import TextInput from './TextInput'
import TextArea from './TextArea'
import Checkbox from '../../../../../../packages/ui/src/Checkbox'
import { useDeferredValue, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  OrganizationSummary,
  SeriesDetail,
  SeriesUpdateInput
} from '@shared/classificationTypes'
import { api } from '../api'
import { organizationKeys } from '../query/queryKeys'
import Modal from './Modal'
import SelectControl from './SelectControl'
import AliasTagEditor from './AliasTagEditor'
import EditFieldAiTranslate from './EditFieldAiTranslate'
import { EditForm, EditFormCheckRow, EditFormField, EditFormFields, EditFormLabelNote, EditFormSection } from './FormPrimitives'
import { createSeriesFormDraft, seriesInputFromDraft } from './seriesFormState'
import ClassificationPicker from './ClassificationPicker'
import { organizationOptionDescription } from './organizationPickerState'
import { promoteAliasToMain } from './aliasEditorState'
import RelatedLinksEditor from './RelatedLinksEditor'

interface Props {
  series?: SeriesDetail | null
  onCancel: () => void
  onSave: (input: SeriesUpdateInput) => Promise<void>
}

export default function SeriesEditModal({ series, onCancel, onSave }: Props): JSX.Element {
  const [draft, setDraft] = useState(() => createSeriesFormDraft(series))
  const [ownerSearch, setOwnerSearch] = useState(series?.ownerOrganization?.mainName ?? '')
  const [selectedOwner, setSelectedOwner] = useState<OrganizationSummary | null>(
    series?.ownerOrganization ?? null
  )
  const [saving, setSaving] = useState(false)
  const deferredOwnerSearch = useDeferredValue(ownerSearch.trim())
  const ownerQuery = useQuery({
    queryKey: organizationKeys.options(deferredOwnerSearch),
    queryFn: () => api.organizations.options(deferredOwnerSearch || undefined),
    placeholderData: (previous) => previous
  })
  const ownerOptions = useMemo(() => {
    const options = ownerQuery.data ?? []
    if (!selectedOwner || options.some((item) => item.id === selectedOwner.id)) return options
    return [{ ...selectedOwner, aliases: [], roles: [] }, ...options]
  }, [ownerQuery.data, selectedOwner])

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
      busy={saving}
      confirmText="保存"
      confirmDisabled={saving || !draft.mainName.trim()}
      onCancel={onCancel}
      onConfirm={save}
    >
      <EditForm>
        <EditFormSection title="名称与简介">
          <EditFormFields>
            <EditFormField label="主名" htmlFor="series-main-name" span={2}>
              <TextInput
                id="series-main-name"
                density="workspace"
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
                  <EditFormLabelNote id="series-aliases-hint">
                    点击设为主名
                  </EditFormLabelNote>
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
              <EditFormCheckRow>
                <Checkbox
                  checked={draft.keepPreviousMainName}
                  onChange={(event) =>
                    setDraft({ ...draft, keepPreviousMainName: event.target.checked })
                  }
                />
                <span>将旧主名保留为别名</span>
              </EditFormCheckRow>
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
              <TextArea
                id="series-summary"
                density="workspace"
                rows={5}
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              />
            </EditFormField>
          </EditFormFields>
        </EditFormSection>

        <EditFormSection title="系列信息">
          <EditFormFields>
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
              <TextInput
                id="series-start-year"
                density="workspace"
                type="number"
                min="1"
                max="9999"
                value={draft.startYear}
                onChange={(event) => setDraft({ ...draft, startYear: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="结束年份" htmlFor="series-end-year">
              <TextInput
                id="series-end-year"
                density="workspace"
                type="number"
                min="1"
                max="9999"
                value={draft.endYear}
                onChange={(event) => setDraft({ ...draft, endYear: event.target.value })}
              />
            </EditFormField>
            <EditFormField
              label="所属机构"
              htmlFor="series-owner"
              span={2}
              hint="搜索并选择；留空表示未归属。不会从影片制作商或发行商推断。"
            >
              <ClassificationPicker
                id="series-owner"
                value={ownerSearch}
                options={ownerOptions.map((option) => ({
                  id: option.id,
                  mainName: option.mainName,
                  description: organizationOptionDescription(option)
                }))}
                selectedId={selectedOwner?.id ?? null}
                listLabel="所属机构候选"
                error={ownerQuery.isError ? '所属机构候选加载失败，请稍后重试。' : undefined}
                placeholder="搜索机构主名或别名…"
                onValueChange={(next) => {
                  setOwnerSearch(next)
                  if (next.trim()) return
                  setSelectedOwner(null)
                  setDraft({ ...draft, ownerOrganizationId: '' })
                }}
                onSelect={(option) => {
                  setOwnerSearch(option.mainName)
                  setSelectedOwner({ id: option.id, mainName: option.mainName })
                  setDraft({ ...draft, ownerOrganizationId: String(option.id) })
                }}
                onDismiss={() => {
                  setOwnerSearch(selectedOwner?.mainName ?? '')
                }}
              />
            </EditFormField>
          </EditFormFields>
        </EditFormSection>

        <RelatedLinksEditor links={draft.links} removeVerb="移除" onChange={(links) => setDraft({ ...draft, links })} />
      </EditForm>
    </Modal>
  )
}
