import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent
} from 'react'
import { FolderPlus, X } from 'lucide-react'
import {
  MEDIA_LIBRARY_COLORS,
  MEDIA_LIBRARY_DEFAULT_SORTS,
  MEDIA_LIBRARY_ICONS,
  type MediaLibraryDetail
} from '@shared/mediaLibraryTypes'
import { api } from '../api'
import { useScraperPluginCatalog } from '../hooks/useScraperPluginCatalog'
import {
  buildCreateMediaLibraryInput,
  createMediaLibraryDraft,
  type CreateMediaLibraryDraft
} from '../mediaLibrarySettingsState'
import Button from './Button'
import { AppFormField, AppFormSection } from './FormPrimitives'
import IconButton from './IconButton'
import { UI_ICON_SM } from './iconDefaults'
import Modal from './Modal'
import { NavIcon } from './NavIcons'
import SelectControl from './SelectControl'
import Switch from './Switch'
import { useToast } from './Toast'
import styles from './MediaLibraryCreateModal.module.css'

const ICON_LABELS: Record<(typeof MEDIA_LIBRARY_ICONS)[number], string> = {
  library: '媒体库',
  film: '影片',
  folder: '文件夹',
  'hard-drive': '硬盘',
  cloud: '云端',
  star: '收藏'
}

const COLOR_LABELS: Record<(typeof MEDIA_LIBRARY_COLORS)[number], string> = {
  slate: '中性',
  blue: '蓝色',
  violet: '紫色',
  rose: '玫红',
  amber: '琥珀',
  green: '绿色'
}

const CREATE_FORM_ID = 'media-library-create-step-form'
const CREATE_STEPS = ['基本信息', '根目录', '扫描配置', '首次扫描'] as const
type CreateStep = 0 | 1 | 2 | 3
type CreateErrorFocus = 'alert' | 'name' | 'scanInterval' | 'minDuration'

function stepForCreateError(message: string): CreateStep {
  if (/名称/.test(message)) return 0
  if (/根目录|路径|来源/.test(message)) return 1
  if (/扫描|周期|时长|刮削|排序/.test(message)) return 2
  return 3
}

function ToggleField({
  title,
  description,
  checked,
  disabled,
  onChange
}: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  return (
    <label className={styles.toggleField}>
      <span className={styles.toggleCopy}>
        <strong className={styles.toggleTitle}>{title}</strong>
        <span className={styles.toggleDescription}>{description}</span>
      </span>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

export default function MediaLibraryCreateModal({
  onCancel,
  onCreated
}: {
  onCancel: () => void
  onCreated: (library: MediaLibraryDetail, scanAfterCreate: boolean) => void
}): JSX.Element {
  const toast = useToast()
  const { scrapers, defaultScraper } = useScraperPluginCatalog('video')
  const [draft, setDraft] = useState<CreateMediaLibraryDraft>(createMediaLibraryDraft)
  const [step, setStep] = useState<CreateStep>(0)
  const [furthestStep, setFurthestStep] = useState<CreateStep>(0)
  const [error, setError] = useState<{
    step: CreateStep
    message: string
    focus: CreateErrorFocus
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const stepHeadingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const scanIntervalRef = useRef<HTMLInputElement>(null)
  const minDurationRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (error?.step === step) {
        if (error.focus === 'name') nameRef.current?.focus()
        else if (error.focus === 'scanInterval') scanIntervalRef.current?.focus()
        else if (error.focus === 'minDuration') minDurationRef.current?.focus()
        else errorRef.current?.focus()
      } else if (step === 0) {
        nameRef.current?.focus()
      } else {
        stepHeadingRef.current?.focus()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [error, step])

  const patchDraft = (patch: Partial<CreateMediaLibraryDraft>): void => {
    setError(null)
    setDraft((current) => ({ ...current, ...patch }))
  }

  const patchConfig = <Key extends keyof CreateMediaLibraryDraft['config']>(
    key: Key,
    value: CreateMediaLibraryDraft['config'][Key]
  ): void => {
    setError(null)
    setDraft((current) => ({
      ...current,
      config: { ...current.config, [key]: value }
    }))
  }

  const pickRoots = async (): Promise<void> => {
    try {
      const paths = await api.settings.pickFolder()
      if (paths.length === 0) return
      setDraft((current) => ({
        ...current,
        roots: [...new Set([...current.roots, ...paths])]
      }))
      setError(null)
    } catch (error) {
      const message = String((error as Error).message ?? error)
      setError({ step: 1, message, focus: 'alert' })
      toast.show(message, 'error')
    }
  }

  const validateCurrentStep = (): boolean => {
    if (step === 0 && !draft.name.trim()) {
      setError({ step, message: '请输入媒体库名称后再继续。', focus: 'name' })
      return false
    }
    if (step === 2) {
      const interval = draft.config.autoScanIntervalMinutes
      if (!Number.isInteger(interval) || interval < 5 || interval > 10_080) {
        setError({
          step,
          message: '自动扫描周期必须为 5 到 10080 分钟的整数。',
          focus: 'scanInterval'
        })
        return false
      }
      const minDuration = draft.config.minImportDurationMinutes
      if (!Number.isInteger(minDuration) || minDuration < 0 || minDuration > 1_440) {
        setError({
          step,
          message: '导入最小时长必须为 0 到 1440 分钟的整数。',
          focus: 'minDuration'
        })
        return false
      }
    }
    return true
  }

  const goToStep = (nextStep: CreateStep): void => {
    if (busy || nextStep > furthestStep) return
    setError(null)
    setStep(nextStep)
  }

  const advance = (): void => {
    if (busy || !validateCurrentStep()) return
    if (step < CREATE_STEPS.length - 1) {
      const nextStep = (step + 1) as CreateStep
      setError(null)
      setFurthestStep((current) => Math.max(current, nextStep) as CreateStep)
      setStep(nextStep)
      return
    }
    void createLibrary()
  }

  const createLibrary = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const input = buildCreateMediaLibraryInput(draft)
      const library = await api.mediaLibraries.create(input)
      onCreated(library, draft.scanAfterCreate && library.activeRootCount > 0)
    } catch (error) {
      const message = String((error as Error).message ?? error)
      const targetStep = stepForCreateError(message)
      setFurthestStep((current) => Math.max(current, targetStep) as CreateStep)
      setStep(targetStep)
      setError({
        step: targetStep,
        message,
        focus:
          targetStep === 0
            ? 'name'
            : targetStep === 2 && /周期/.test(message)
              ? 'scanInterval'
              : targetStep === 2 && /时长/.test(message)
                ? 'minDuration'
                : 'alert'
      })
      toast.show(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="新建媒体库"
      subtitle={`第 ${step + 1} 步，共 ${CREATE_STEPS.length} 步`}
      hint="依次设置识别信息、来源与独立配置；根目录和首次扫描均可跳过。"
      size="lg"
      bodyClassName={styles.modalBody}
      busy={busy}
      onCancel={onCancel}
      actions={
        <>
          <Button
            className={styles.cancelButton}
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </Button>
          {step > 0 ? (
            <Button
              disabled={busy}
              onClick={() => goToStep((step - 1) as CreateStep)}
            >
              上一步
            </Button>
          ) : null}
          <Button
            type="submit"
            form={CREATE_FORM_ID}
            variant="primary"
            disabled={busy}
          >
            {step === CREATE_STEPS.length - 1 ? '创建媒体库' : '下一步'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <nav aria-label="创建媒体库步骤">
          <ol className={styles.stepper}>
            {CREATE_STEPS.map((label, index) => {
              const stepIndex = index as CreateStep
              const state =
                stepIndex === step ? 'current' : stepIndex <= furthestStep ? 'complete' : 'upcoming'
              return (
                <li className={styles.stepItem} key={label}>
                  <button
                    className={styles.stepButton}
                    type="button"
                    data-state={state}
                    aria-current={state === 'current' ? 'step' : undefined}
                    aria-label={`第 ${index + 1} 步：${label}`}
                    disabled={busy || stepIndex > furthestStep}
                    onClick={() => goToStep(stepIndex)}
                  >
                    <span className={styles.stepNumber} aria-hidden>{index + 1}</span>
                    <span className={styles.stepLabel}>{label}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <form
          className={styles.stepPanel}
          id={CREATE_FORM_ID}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            advance()
          }}
        >
          <header className={styles.stepHeader}>
            <h4 className={styles.stepTitle} ref={stepHeadingRef} tabIndex={-1}>
              {CREATE_STEPS[step]}
            </h4>
            <p className={styles.stepHint}>
              {step === 0
                ? '设置侧栏中可辨识的名称、图标和颜色。'
                : step === 1
                  ? '选择此库独占管理的目录；也可以先创建空库。'
                  : step === 2
                    ? '这些扫描、刮削、列表与首页选项只作用于当前媒体库。'
                    : '确认摘要，并决定创建完成后是否立即扫描。'}
            </p>
          </header>

          {error?.step === step ? (
            <div
              className={styles.error}
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              id="media-library-create-error"
            >
              {error.message}
            </div>
          ) : null}

          {step === 0 ? (
            <AppFormSection title="名称与识别">
              <AppFormField label="媒体库名称">
                <input
                  ref={nameRef}
                  className={`text-input ${styles.control}`}
                  value={draft.name}
                  maxLength={200}
                  disabled={busy}
                  placeholder="例如：本地影片、NAS 收藏"
                  aria-invalid={Boolean(error?.step === 0) || undefined}
                  aria-describedby={error?.step === 0 ? 'media-library-create-error' : undefined}
                  onChange={(event) => patchDraft({ name: event.target.value })}
                />
              </AppFormField>
              <div className={styles.choiceGrid}>
                {MEDIA_LIBRARY_ICONS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    className={styles.iconChoice}
                    aria-label={ICON_LABELS[icon]}
                    aria-pressed={draft.icon === icon}
                    disabled={busy}
                    onClick={() => patchDraft({ icon })}
                  >
                    <NavIcon name={icon} />
                    <span>{ICON_LABELS[icon]}</span>
                  </button>
                ))}
              </div>
              <div className={styles.choiceGrid}>
                {MEDIA_LIBRARY_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={styles.colorChoice}
                    data-color={color}
                    aria-label={`强调色：${COLOR_LABELS[color]}`}
                    aria-pressed={draft.color === color}
                    disabled={busy}
                    onClick={() => patchDraft({ color })}
                  >
                    <span className={styles.colorDot} aria-hidden />
                    {COLOR_LABELS[color]}
                  </button>
                ))}
              </div>
            </AppFormSection>
          ) : null}

          {step === 1 ? (
            <AppFormSection
              title="来源目录（可选）"
              hint="所选目录会以启用状态加入；同一路径不能属于多个启用媒体库。"
              actions={
                <Button size="sm" disabled={busy} onClick={() => void pickRoots()}>
                  <FolderPlus {...UI_ICON_SM} aria-hidden />
                  选择目录
                </Button>
              }
            >
              {draft.roots.length === 0 ? (
                <div className={styles.emptyRoots}>暂不添加，创建后可在媒体库设置中补充。</div>
              ) : (
                <div className={styles.rootList} aria-label="已选择的来源目录">
                  {draft.roots.map((path) => (
                    <div className={styles.rootRow} key={path}>
                      <span className={`${styles.rootPath} copyable-text`} title={path}>
                        {path}
                      </span>
                      <IconButton
                        size="sm"
                        label={`移除来源目录 ${path}`}
                        icon={<X {...UI_ICON_SM} />}
                        disabled={busy}
                        onClick={() =>
                          patchDraft({
                            roots: draft.roots.filter((item) => item !== path),
                            scanAfterCreate:
                              draft.roots.length > 1 ? draft.scanAfterCreate : false
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </AppFormSection>
          ) : null}

          {step === 2 ? (
            <div className={styles.configSections}>
              <AppFormSection title="扫描行为">
                <div className={styles.fieldGrid}>
                  <AppFormField label="自动扫描周期" hint="5–10080 分钟">
                    <input
                      ref={scanIntervalRef}
                      className={`text-input ${styles.control}`}
                      type="number"
                      min={5}
                      max={10_080}
                      step={1}
                      value={draft.config.autoScanIntervalMinutes}
                      disabled={busy || !draft.config.autoScanEnabled}
                      aria-invalid={
                        error?.step === 2 && /周期/.test(error.message) ? true : undefined
                      }
                      aria-describedby={error?.step === 2 ? 'media-library-create-error' : undefined}
                      onChange={(event) =>
                        patchConfig('autoScanIntervalMinutes', Number(event.target.value))
                      }
                    />
                  </AppFormField>
                  <AppFormField label="导入最小时长" hint="0–1440 分钟">
                    <input
                      ref={minDurationRef}
                      className={`text-input ${styles.control}`}
                      type="number"
                      min={0}
                      max={1_440}
                      step={1}
                      value={draft.config.minImportDurationMinutes}
                      disabled={busy}
                      aria-invalid={
                        error?.step === 2 && /最小时长/.test(error.message) ? true : undefined
                      }
                      aria-describedby={error?.step === 2 ? 'media-library-create-error' : undefined}
                      onChange={(event) =>
                        patchConfig('minImportDurationMinutes', Number(event.target.value))
                      }
                    />
                  </AppFormField>
                </div>
                <ToggleField
                  title="自动扫描"
                  description="按周期扫描当前库的启用目录。"
                  checked={draft.config.autoScanEnabled}
                  disabled={busy}
                  onChange={(value) => patchConfig('autoScanEnabled', value)}
                />
                <ToggleField
                  title="同番号自动合并资源"
                  description="扫描到同番号文件时直接加入现有影片成员。"
                  checked={draft.config.autoMergeSameCodeResources}
                  disabled={busy}
                  onChange={(value) => patchConfig('autoMergeSameCodeResources', value)}
                />
                <ToggleField
                  title="清理无资源成员"
                  description="安全清理后移除当前库内不再拥有资源的影片成员。"
                  checked={draft.config.removeResourceLessMemberships}
                  disabled={busy}
                  onChange={(value) => patchConfig('removeResourceLessMemberships', value)}
                />
              </AppFormSection>

              <AppFormSection title="刮削与列表默认值" hint="创建后仍可在媒体库设置中调整。">
                <div className={styles.fieldGrid}>
                  <AppFormField label="默认影片刮削器">
                    <SelectControl
                      value={draft.config.defaultVideoScraper ?? ''}
                      disabled={busy}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        patchConfig('defaultVideoScraper', event.target.value || null)
                      }
                    >
                      <option value="">
                        跟随全局默认{defaultScraper ? `（${defaultScraper}）` : ''}
                      </option>
                      {scrapers.map((scraper) => (
                        <option key={scraper} value={scraper}>
                          {scraper}
                        </option>
                      ))}
                    </SelectControl>
                  </AppFormField>
                  <AppFormField label="默认排序">
                    <SelectControl
                      value={draft.config.defaultSortBy}
                      disabled={busy}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        patchConfig(
                          'defaultSortBy',
                          event.target.value as CreateMediaLibraryDraft['config']['defaultSortBy']
                        )
                      }
                    >
                      {MEDIA_LIBRARY_DEFAULT_SORTS.map((sort) => (
                        <option key={sort} value={sort}>
                          {{
                            add_time: '添加时间',
                            release_date: '发行日期',
                            rating: '评分',
                            code: '番号'
                          }[sort]}
                        </option>
                      ))}
                    </SelectControl>
                  </AppFormField>
                  <AppFormField label="默认方向">
                    <SelectControl
                      value={draft.config.defaultSortDir}
                      disabled={busy}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        patchConfig(
                          'defaultSortDir',
                          event.target.value as CreateMediaLibraryDraft['config']['defaultSortDir']
                        )
                      }
                    >
                      <option value="desc">降序</option>
                      <option value="asc">升序</option>
                    </SelectControl>
                  </AppFormField>
                </div>
                <ToggleField
                  title="参与首页发现"
                  description="加入随机推荐与近期添加。"
                  checked={draft.config.includeInHomeDiscovery}
                  disabled={busy}
                  onChange={(value) => patchConfig('includeInHomeDiscovery', value)}
                />
              </AppFormSection>
            </div>
          ) : null}

          {step === 3 ? (
            <div className={styles.review}>
              <dl className={styles.summaryGrid}>
                <div className={styles.summaryItem}>
                  <dt className={styles.summaryLabel}>媒体库</dt>
                  <dd className={styles.summaryValue}>{draft.name.trim()}</dd>
                </div>
                <div className={styles.summaryItem}>
                  <dt className={styles.summaryLabel}>来源目录</dt>
                  <dd className={styles.summaryValue}>
                    {draft.roots.length > 0 ? `${draft.roots.length} 个` : '暂不添加'}
                  </dd>
                </div>
                <div className={styles.summaryItem}>
                  <dt className={styles.summaryLabel}>自动扫描</dt>
                  <dd className={styles.summaryValue}>
                    {draft.config.autoScanEnabled
                      ? `每 ${draft.config.autoScanIntervalMinutes} 分钟`
                      : '关闭'}
                  </dd>
                </div>
                <div className={styles.summaryItem}>
                  <dt className={styles.summaryLabel}>首页发现</dt>
                  <dd className={styles.summaryValue}>
                    {draft.config.includeInHomeDiscovery ? '参与' : '不参与'}
                  </dd>
                </div>
              </dl>
              <ToggleField
                title="创建后立即扫描"
                description={
                  draft.roots.length > 0
                    ? '创建完成后扫描本次选择的所有目录。'
                    : '当前将创建空媒体库；添加来源目录后再开始扫描。'
                }
                checked={draft.scanAfterCreate && draft.roots.length > 0}
                disabled={busy || draft.roots.length === 0}
                onChange={(value) => patchDraft({ scanAfterCreate: value })}
              />
              <p className={styles.reviewNote}>
                创建只会写入媒体库配置；源文件不会被移动或删除。
              </p>
            </div>
          ) : null}
        </form>
      </div>
    </Modal>
  )
}
