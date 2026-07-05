import { useCallback, useMemo, useState } from 'react'
import {
  BLOOD_TYPE_OPTIONS,
  CUP_SIZE_LETTERS,
  NATIONALITY_OPTIONS,
  ZODIAC_OPTIONS,
  actressGenderMergeLabel,
  actressMergeGenderGroup,
  filterCjkName,
  filterLatinName,
  filterPositiveInt,
  isIsoDate,
  toDateInputValue,
  withCurrentSelectOption
} from '@shared/actressProfileOptions'
import { normalizeCupSize } from '@shared/cupSizeUtils'
import type { ActressDetail, ActressEditInput, ActressGender } from '@shared/types'
import { assetUrl } from '../api'
import ActressAvatarEditor from './ActressAvatarEditor'
import AliasTagEditor from './AliasTagEditor'
import EditFieldAiTranslate from './EditFieldAiTranslate'
import { EditFormField, EditFormSection } from './FormPrimitives'
import Modal from './Modal'
import SelectControl from './SelectControl'

interface Props {
  actress: ActressDetail
  onCancel: () => void
  onSave: (input: ActressEditInput) => Promise<void>
}

/** Modal form for manually editing an actress profile. */
export default function EditActressModal({ actress, onCancel, onSave }: Props): JSX.Element {
  const [mainName, setMainName] = useState(actress.main_name)
  const [nameZh, setNameZh] = useState(actress.name_zh ?? '')
  const [nameEn, setNameEn] = useState(actress.name_en ?? '')
  const [gender, setGender] = useState<ActressGender | null>(actress.gender ?? null)
  const [birthDate, setBirthDate] = useState(toDateInputValue(actress.birth_date))
  const [debutDate, setDebutDate] = useState(toDateInputValue(actress.debut_date))
  const [heightCm, setHeightCm] = useState(
    actress.height_cm != null ? String(actress.height_cm) : ''
  )
  const [bustCm, setBustCm] = useState(actress.bust_cm != null ? String(actress.bust_cm) : '')
  const [waistCm, setWaistCm] = useState(actress.waist_cm != null ? String(actress.waist_cm) : '')
  const [hipCm, setHipCm] = useState(actress.hip_cm != null ? String(actress.hip_cm) : '')
  const [cupSize, setCupSize] = useState(normalizeCupSize(actress.cup_size) ?? '')
  const [bloodType, setBloodType] = useState(actress.blood_type?.trim() ?? '')
  const [zodiac, setZodiac] = useState(actress.zodiac?.trim() ?? '')
  const [nationality, setNationality] = useState(actress.nationality?.trim() ?? '')
  const [profileSummary, setProfileSummary] = useState(actress.profile_summary ?? '')
  const [aliases, setAliases] = useState<string[]>([...actress.aliases])
  const [avatarImageBase64, setAvatarImageBase64] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const bloodTypeOptions = useMemo(
    () => withCurrentSelectOption(BLOOD_TYPE_OPTIONS, bloodType),
    [bloodType]
  )
  const zodiacOptions = useMemo(() => withCurrentSelectOption(ZODIAC_OPTIONS, zodiac), [zodiac])
  const nationalityOptions = useMemo(
    () => withCurrentSelectOption(NATIONALITY_OPTIONS, nationality),
    [nationality]
  )

  const isMaleProfile = actressMergeGenderGroup(gender) === 'male'
  const allowUnknownGender = actress.gender == null

  const handleGenderChange = (next: ActressGender | null): void => {
    setGender(next)
    if (actressMergeGenderGroup(next) === 'male') {
      setBustCm('')
      setWaistCm('')
      setHipCm('')
      setCupSize('')
    }
  }

  const handleAvatarChange = useCallback((base64: string | null) => {
    setAvatarImageBase64(base64)
  }, [])

  const nameKey = useCallback((name: string) => name.toLowerCase().replace(/\s+/g, ''), [])

  const handlePromoteAliasToMain = useCallback(
    (alias: string) => {
      const nextMain = alias.trim()
      if (!nextMain) return
      const prevMain = mainName.trim()
      let nextAliases = aliases.filter((item) => nameKey(item) !== nameKey(nextMain))
      if (prevMain && nameKey(prevMain) !== nameKey(nextMain)) {
        if (!nextAliases.some((item) => nameKey(item) === nameKey(prevMain))) {
          nextAliases = [...nextAliases, prevMain]
        }
      }
      setMainName(nextMain)
      setAliases(nextAliases)
    },
    [aliases, mainName, nameKey]
  )

  const numberOrNull = (value: string): number | null => {
    const trimmed = value.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        main_name: mainName.trim(),
        name_zh: nameZh.trim() || null,
        name_en: nameEn.trim() || null,
        gender,
        birth_date: birthDate.trim() || null,
        debut_date: debutDate.trim() || null,
        height_cm: numberOrNull(heightCm),
        bust_cm: isMaleProfile ? null : numberOrNull(bustCm),
        waist_cm: isMaleProfile ? null : numberOrNull(waistCm),
        hip_cm: isMaleProfile ? null : numberOrNull(hipCm),
        cup_size: isMaleProfile ? null : normalizeCupSize(cupSize),
        blood_type: bloodType.trim() || null,
        zodiac: zodiac.trim() || null,
        nationality: nationality.trim() || null,
        profile_summary: profileSummary.trim() || null,
        aliases,
        ...(avatarImageBase64 ? { avatarImageBase64 } : {})
      })
    } finally {
      setSaving(false)
    }
  }

  const dateInvalid =
    (birthDate !== '' && !isIsoDate(birthDate)) || (debutDate !== '' && !isIsoDate(debutDate))

  const displayName = mainName.trim() || actress.main_name

  return (
    <Modal
      title={`编辑${actressGenderMergeLabel(gender)}资料`}
      subtitle={displayName}
      size="xl"
      className="modal-entity-edit"
      confirmText={saving ? '保存中…' : '保存'}
      confirmDisabled={saving || !mainName.trim() || dateInvalid}
      onCancel={onCancel}
      onConfirm={() => void handleSave()}
    >
      <div className="entity-edit-form">
            <EditFormSection title="头像" className="entity-edit-section--media">
              <ActressAvatarEditor
                currentUrl={assetUrl(actress.avatar_path)}
                videos={actress.videos}
                gallery={actress.gallery}
                onAvatarChange={handleAvatarChange}
              />
            </EditFormSection>

            <EditFormSection title="姓名">
              <div className="entity-edit-fields">
                <EditFormField label="主名" htmlFor="actress-main-name" span={2}>
                  <input
                    id="actress-main-name"
                    className="text-input"
                    value={mainName}
                    onChange={(e) => setMainName(e.target.value)}
                    required
                  />
                </EditFormField>

                <EditFormField label="中文名" htmlFor="actress-name-zh">
                  <input
                    id="actress-name-zh"
                    className="text-input"
                    value={nameZh}
                    onChange={(e) => setNameZh(filterCjkName(e.target.value))}
                    placeholder="汉字或假名"
                  />
                </EditFormField>

                <EditFormField label="英文名" htmlFor="actress-name-en">
                  <input
                    id="actress-name-en"
                    className="text-input"
                    value={nameEn}
                    onChange={(e) => setNameEn(filterLatinName(e.target.value))}
                    placeholder="Latin letters"
                    autoComplete="off"
                  />
                </EditFormField>

                <EditFormField
                  label="别名"
                  htmlFor="actress-aliases"
                  span={2}
                  labelExtra={
                    aliases.length > 0 ? (
                      <span id="actress-aliases-hint" className="entity-edit-label-note">
                        点击设为主名
                      </span>
                    ) : undefined
                  }
                >
                  <AliasTagEditor
                    id="actress-aliases"
                    aliases={aliases}
                    onChange={setAliases}
                    onPromoteToMain={handlePromoteAliasToMain}
                    disabled={saving}
                    aria-describedby={aliases.length > 0 ? 'actress-aliases-hint' : undefined}
                  />
                </EditFormField>
              </div>
            </EditFormSection>

            <EditFormSection title="基本资料">
              <div className="entity-edit-fields">
                <EditFormField label="性别" span={2}>
                  <div className="mode-toggle mode-toggle--stretch">
                    <button
                      type="button"
                      className={gender === 'female' ? 'active' : ''}
                      onClick={() => handleGenderChange('female')}
                    >
                      女优
                    </button>
                    <button
                      type="button"
                      className={gender === 'male' ? 'active' : ''}
                      onClick={() => handleGenderChange('male')}
                    >
                      男优
                    </button>
                    {allowUnknownGender ? (
                      <button
                        type="button"
                        className={gender === null ? 'active' : ''}
                        onClick={() => handleGenderChange(null)}
                      >
                        未知
                      </button>
                    ) : null}
                  </div>
                </EditFormField>

                <EditFormField label="国籍" htmlFor="actress-nationality">
                  <SelectControl
                    id="actress-nationality"
                    value={nationality}
                    onChange={(e) => setNationality(e.target.value)}
                  >
                    {nationalityOptions.map((opt) => (
                      <option key={opt.value || 'empty'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </SelectControl>
                </EditFormField>

                <EditFormField label="生日" htmlFor="actress-birth-date">
                  <input
                    id="actress-birth-date"
                    className="text-input"
                    type="date"
                    value={birthDate}
                    onChange={(e) => setBirthDate(e.target.value)}
                  />
                </EditFormField>

                <EditFormField label="出道" htmlFor="actress-debut-date">
                  <input
                    id="actress-debut-date"
                    className="text-input"
                    type="date"
                    value={debutDate}
                    onChange={(e) => setDebutDate(e.target.value)}
                  />
                </EditFormField>

                <EditFormField label="血型" htmlFor="actress-blood-type">
                  <SelectControl
                    id="actress-blood-type"
                    value={bloodType}
                    onChange={(e) => setBloodType(e.target.value)}
                  >
                    {bloodTypeOptions.map((opt) => (
                      <option key={opt.value || 'empty'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </SelectControl>
                </EditFormField>

                <EditFormField label="星座" htmlFor="actress-zodiac">
                  <SelectControl
                    id="actress-zodiac"
                    value={zodiac}
                    onChange={(e) => setZodiac(e.target.value)}
                  >
                    {zodiacOptions.map((opt) => (
                      <option key={opt.value || 'empty'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </SelectControl>
                </EditFormField>

                <EditFormField
                  label="简介"
                  htmlFor="actress-summary"
                  span={2}
                  labelExtra={
                    <EditFieldAiTranslate
                      text={profileSummary}
                      disabled={saving}
                      onTranslated={setProfileSummary}
                    />
                  }
                >
                  <textarea
                    id="actress-summary"
                    className="text-input"
                    rows={3}
                    value={profileSummary}
                    onChange={(e) => setProfileSummary(e.target.value)}
                  />
                </EditFormField>
              </div>
            </EditFormSection>

            <EditFormSection title={isMaleProfile ? '体型' : '身体数据'}>
              <div className="entity-edit-fields">
                <EditFormField label="身高" htmlFor="actress-height" span={isMaleProfile ? 2 : 1}>
                  <div className="entity-edit-input-suffix">
                    <input
                      id="actress-height"
                      className="text-input"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={heightCm}
                      onChange={(e) => setHeightCm(filterPositiveInt(e.target.value, 3))}
                      placeholder="整数"
                    />
                    <span className="entity-edit-input-unit">cm</span>
                  </div>
                </EditFormField>

                {!isMaleProfile ? (
                  <>
                    <EditFormField label="罩杯" htmlFor="actress-cup-size">
                      <SelectControl
                        id="actress-cup-size"
                        value={cupSize}
                        onChange={(e) => setCupSize(e.target.value)}
                      >
                        <option value="">—</option>
                        {CUP_SIZE_LETTERS.map((letter) => (
                          <option key={letter} value={letter}>
                            {letter} Cup
                          </option>
                        ))}
                      </SelectControl>
                    </EditFormField>

                    <EditFormField label="三围" span={2}>
                      <div className="inline-field-row">
                        <div className="entity-edit-input-suffix">
                          <input
                            className="text-input"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            placeholder="胸"
                            aria-label="胸围(cm)"
                            value={bustCm}
                            onChange={(e) => setBustCm(filterPositiveInt(e.target.value, 3))}
                          />
                          <span className="entity-edit-input-unit">cm</span>
                        </div>
                        <div className="entity-edit-input-suffix">
                          <input
                            className="text-input"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            placeholder="腰"
                            aria-label="腰围(cm)"
                            value={waistCm}
                            onChange={(e) => setWaistCm(filterPositiveInt(e.target.value, 3))}
                          />
                          <span className="entity-edit-input-unit">cm</span>
                        </div>
                        <div className="entity-edit-input-suffix">
                          <input
                            className="text-input"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            placeholder="臀"
                            aria-label="臀围(cm)"
                            value={hipCm}
                            onChange={(e) => setHipCm(filterPositiveInt(e.target.value, 3))}
                          />
                          <span className="entity-edit-input-unit">cm</span>
                        </div>
                      </div>
                    </EditFormField>
                  </>
                ) : null}
              </div>
            </EditFormSection>
          </div>
    </Modal>
  )
}
