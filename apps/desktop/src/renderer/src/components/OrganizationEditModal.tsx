import TextInput from './TextInput'
import TextArea from './TextArea'
import Checkbox from '../../../../../../packages/ui/src/Checkbox'
import { useState } from 'react'
import type {
  OrganizationDetail,
  OrganizationRole,
  OrganizationUpdateInput
} from '@shared/classificationTypes'
import Modal from './Modal'
import SelectControl from './SelectControl'
import AliasTagEditor from './AliasTagEditor'
import EditFieldAiTranslate from './EditFieldAiTranslate'
import { EditForm, EditFormCheckRow, EditFormField, EditFormFields, EditFormLabelNote, EditFormSection } from './FormPrimitives'
import {
  createOrganizationFormDraft,
  organizationUpdateInputFromDraft
} from './organizationFormState'
import { promoteAliasToMain } from './aliasEditorState'
import RelatedLinksEditor from './RelatedLinksEditor'
import { FACET_LABEL } from '../facet'

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
  const [saving, setSaving] = useState(false)
  const isEditing = Boolean(organization)

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
      busy={saving}
      confirmText="保存"
      confirmDisabled={saving || !draft.mainName.trim()}
      onCancel={onCancel}
      onConfirm={save}
    >
      <EditForm>
        <EditFormSection title="名称与简介">
          <EditFormFields>
            <EditFormField label="主名" htmlFor="organization-main-name" span={2}>
              <TextInput
                id="organization-main-name"
                density="workspace"
                value={draft.mainName}
                autoFocus
                onChange={(event) => setDraft({ ...draft, mainName: event.target.value })}
              />
            </EditFormField>
            <EditFormField
              label="别名"
              htmlFor="organization-aliases"
              span={2}
              labelExtra={
                draft.aliases.length > 0 ? (
                  <EditFormLabelNote id="organization-aliases-hint">
                    点击设为主名
                  </EditFormLabelNote>
                ) : undefined
              }
            >
              <AliasTagEditor
                id="organization-aliases"
                aliases={draft.aliases}
                onChange={(aliases) => setDraft({ ...draft, aliases })}
                onPromoteToMain={(alias) =>
                  setDraft({ ...draft, ...promoteAliasToMain(draft.mainName, draft.aliases, alias) })
                }
                disabled={saving}
                aria-describedby={draft.aliases.length > 0 ? 'organization-aliases-hint' : undefined}
              />
            </EditFormField>
            {isEditing && draft.mainName.trim() !== organization?.mainName ? (
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
              htmlFor="organization-summary"
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
                id="organization-summary"
                density="workspace"
                rows={5}
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              />
            </EditFormField>
          </EditFormFields>
        </EditFormSection>

        <EditFormSection title="机构信息">
          <EditFormFields>
            <EditFormField label="国家或地区" htmlFor="organization-country">
              <TextInput
                id="organization-country"
                density="workspace"
                value={draft.countryRegion}
                onChange={(event) => setDraft({ ...draft, countryRegion: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="状态" htmlFor="organization-status">
              <SelectControl
                id="organization-status"
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
              </SelectControl>
            </EditFormField>
            <EditFormField label="成立年份" htmlFor="organization-founded-year">
              <TextInput
                id="organization-founded-year"
                density="workspace"
                inputMode="numeric"
                value={draft.foundedYear}
                onChange={(event) => setDraft({ ...draft, foundedYear: event.target.value })}
              />
            </EditFormField>
            <EditFormField label="停止年份" htmlFor="organization-ended-year">
              <TextInput
                id="organization-ended-year"
                density="workspace"
                inputMode="numeric"
                value={draft.endedYear}
                onChange={(event) => setDraft({ ...draft, endedYear: event.target.value })}
              />
            </EditFormField>
          </EditFormFields>
        </EditFormSection>

        <RelatedLinksEditor links={draft.links} removeVerb="移除" onChange={(links) => setDraft({ ...draft, links })} />
      </EditForm>
    </Modal>
  )
}
