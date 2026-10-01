import TextInput from './TextInput'
import TextArea from './TextArea'
import Checkbox from '../../../../../../packages/ui/src/Checkbox'
import { useState } from 'react'
import type { DirectorDetail, DirectorUpdateInput } from '@shared/classificationTypes'
import Modal from './Modal'
import AliasTagEditor from './AliasTagEditor'
import EditFieldAiTranslate from './EditFieldAiTranslate'
import { EditForm, EditFormCheckRow, EditFormField, EditFormFields, EditFormLabelNote, EditFormSection } from './FormPrimitives'
import { createDirectorFormDraft, directorInputFromDraft } from './directorFormState'
import { promoteAliasToMain } from './aliasEditorState'
import RelatedLinksEditor from './RelatedLinksEditor'

interface Props {
  director?: DirectorDetail | null
  onCancel: () => void
  onSave: (input: DirectorUpdateInput) => Promise<void>
}

export default function DirectorEditModal({ director, onCancel, onSave }: Props): JSX.Element {
  const [draft, setDraft] = useState(() => createDirectorFormDraft(director))
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
      busy={saving}
      confirmText="保存"
      confirmDisabled={saving || !draft.mainName.trim()}
      onCancel={onCancel}
      onConfirm={save}
    >
      <EditForm>
        <EditFormSection title="名称与简介">
          <EditFormFields>
            <EditFormField label="主名" htmlFor="director-main-name" span={2}>
              <TextInput
                id="director-main-name"
                density="workspace"
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
                  <EditFormLabelNote id="director-aliases-hint">
                    点击设为主名
                  </EditFormLabelNote>
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
              <EditFormCheckRow>
                <Checkbox
                  checked={draft.keepPreviousMainName}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      keepPreviousMainName: e.target.checked,
                    })
                  }
                />
                将旧主名保留为别名
              </EditFormCheckRow>
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
              <TextArea
                id="director-summary"
                density="workspace"
                rows={5}
                value={draft.summary}
                onChange={(e) => field('summary', e.target.value)}
              />
            </EditFormField>
          </EditFormFields>
        </EditFormSection>
        <RelatedLinksEditor links={draft.links} onChange={(links) => setDraft({ ...draft, links })} />
      </EditForm>
    </Modal>
  )
}
