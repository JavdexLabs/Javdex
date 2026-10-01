import Checkbox from '../../../../../../packages/ui/src/Checkbox'
import {
  formatActressScrapeMatchNameLabel,
  type ActressScrapeMatchNameOption
} from '@shared/actressProfileOptions'
import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import { useEffect, useMemo, useState } from 'react'
import ScraperSiteSelect from './ScraperSiteSelect'
import SelectControl from './SelectControl'
import SettingsSwitchRow from './SettingsSwitchRow'
import SettingsToggleList from './SettingsToggleList'
import Modal from './Modal'
import Button from './Button'
import { SegmentedActions, SegmentedAction } from './SegmentedActions'
import styles from './ScrapeFieldsModal.module.css'

export interface ScrapeFieldOption<T extends string> {
  id: T
  label: string
}

export interface ScrapeScopeOption<S extends string | number> {
  id: S
  label: string
  description?: string
}

export type ScrapeMatchNameOption = ActressScrapeMatchNameOption

interface ScrapeFieldGroup<T extends string> {
  id: string
  label: string
  options: ScrapeFieldOption<T>[]
}

const FIELD_GROUP_META: Record<string, { id: string; label: string }> = {
  title: { id: 'basic', label: '基本信息' },
  summary: { id: 'basic', label: '基本信息' },
  releaseDate: { id: 'basic', label: '基本信息' },
  director: { id: 'basic', label: '基本信息' },
  duration: { id: 'basic', label: '基本信息' },
  cover: { id: 'assets', label: '媒体资产' },
  samples: { id: 'assets', label: '媒体资产' },
  maker: { id: 'taxonomy', label: '标签与分类' },
  publisher: { id: 'taxonomy', label: '标签与分类' },
  series: { id: 'taxonomy', label: '标签与分类' },
  tags: { id: 'taxonomy', label: '标签与分类' },
  actressesFemale: { id: 'taxonomy', label: '标签与分类' },
  actressesMale: { id: 'taxonomy', label: '标签与分类' },
  source: { id: 'taxonomy', label: '标签与分类' },
  rating: { id: 'taxonomy', label: '标签与分类' },
  avatar: { id: 'actor-media', label: '媒体资产' },
  gallery: { id: 'actor-media', label: '媒体资产' },
  birthDate: { id: 'actor-profile', label: '演员资料' },
  nameZh: { id: 'actor-profile', label: '演员资料' },
  nameEn: { id: 'actor-profile', label: '演员资料' },
  debutDate: { id: 'actor-profile', label: '演员资料' },
  bloodType: { id: 'actor-profile', label: '演员资料' },
  zodiac: { id: 'actor-profile', label: '演员资料' },
  nationality: { id: 'actor-profile', label: '演员资料' },
  profileSummary: { id: 'actor-profile', label: '演员资料' },
  aliases: { id: 'actor-profile', label: '演员资料' },
  heightCm: { id: 'actor-physique', label: '身材数据' },
  measurements: { id: 'actor-physique', label: '身材数据' },
  cupSize: { id: 'actor-physique', label: '身材数据' }
}

function groupFieldOptions<T extends string>(options: ScrapeFieldOption<T>[]): ScrapeFieldGroup<T>[] {
  const groups = new Map<string, ScrapeFieldGroup<T>>()
  for (const option of options) {
    const meta = FIELD_GROUP_META[option.id] ?? { id: 'other', label: '其他字段' }
    const existing = groups.get(meta.id)
    if (existing) {
      existing.options.push(option)
    } else {
      groups.set(meta.id, { id: meta.id, label: meta.label, options: [option] })
    }
  }
  return [...groups.values()]
}

function isReplaceUpdateMode(mode: string | undefined): boolean {
  return mode === 'replace'
}

function resolveInitialUpdateMode(
  initialUpdateMode: string | undefined,
  updateModeOptions: ScrapeScopeOption<string>[] | undefined
): string | undefined {
  if (initialUpdateMode) return initialUpdateMode
  if (updateModeOptions?.some((o) => o.id === 'fillEmpty')) return 'fillEmpty'
  return updateModeOptions?.[0]?.id
}

function scopeOptionLabel<V extends string | number>(
  options: ScrapeScopeOption<V>[] | undefined,
  value: V | undefined
): string | undefined {
  return options?.find((option) => option.id === value)?.label
}

interface Props<T extends string, S extends string | number = never, A extends string | number = never> {
  title: string
  hint?: string
  options: ScrapeFieldOption<T>[]
  scrapers: string[]
  pluginDetails?: ScraperPluginDescriptor[]
  initialScraperName: string
  initialSelected?: T[]
  scraperTitle?: string
  confirmText?: string
  scopeOptions?: ScrapeScopeOption<S>[]
  initialScope?: S
  scopeTitle?: string
  scopeCountLabel?: string
  onScopeChange?: (scope: S, missingFields: T[], auxScope?: A, scraperName?: string) => void
  auxScopeOptions?: ScrapeScopeOption<A>[]
  initialAuxScope?: A
  auxScopeTitle?: string
  missingFieldOptions?: ScrapeFieldOption<T>[]
  initialMissingFields?: T[]
  missingFieldHint?: string
  onMissingFieldsChange?: (
    missingFields: T[],
    scope?: S,
    auxScope?: A,
    scraperName?: string
  ) => void
  updateModeOptions?: ScrapeScopeOption<string>[]
  initialUpdateMode?: string
  updateModeHint?: string
  matchNameOptions?: ScrapeMatchNameOption[]
  initialMatchName?: string
  matchNameTitle?: string
  matchNameHint?: string
  showUseAliasesToggle?: boolean
  initialUseAliases?: boolean
  useAliasesHint?: string
  showAutoCropAvatarToggle?: boolean
  initialAutoCropAvatar?: boolean
  autoCropAvatarHint?: string
  onCancel: () => void
  onConfirm: (
    selected: T[],
    scraperName: string,
    scope?: S,
    updateMode?: string,
    missingFields?: T[],
    matchName?: string,
    useAliases?: boolean,
    auxScope?: A,
    autoCropAvatar?: boolean
  ) => void
}

/** Modal for choosing scrape site, scope, update mode, and metadata fields. */
export default function ScrapeFieldsModal<
  T extends string,
  S extends string | number = never,
  A extends string | number = never
>({
  title,
  hint = '配置本次刮削的目标、写入方式和字段。',
  options,
  scrapers,
  pluginDetails,
  initialScraperName,
  initialSelected,
  scraperTitle = '刮削站点',
  confirmText = '开始修正',
  scopeOptions,
  initialScope,
  scopeTitle = '影片范围',
  scopeCountLabel,
  onScopeChange,
  auxScopeOptions,
  initialAuxScope,
  auxScopeTitle = '刮削状态',
  missingFieldOptions,
  initialMissingFields,
  missingFieldHint,
  onMissingFieldsChange,
  updateModeOptions,
  initialUpdateMode,
  updateModeHint,
  matchNameOptions,
  initialMatchName,
  matchNameTitle = '匹配名称',
  matchNameHint,
  showUseAliasesToggle = false,
  initialUseAliases = false,
  useAliasesHint,
  showAutoCropAvatarToggle = false,
  initialAutoCropAvatar = false,
  autoCropAvatarHint,
  onCancel,
  onConfirm
}: Props<T, S, A>): JSX.Element {
  const allIds = options.map((o) => o.id)
  const missingIds = missingFieldOptions?.map((o) => o.id) ?? []
  const supportByPlugin = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const plugin of pluginDetails ?? []) {
      map.set(plugin.name, new Set(plugin.supportedFields))
    }
    return map
  }, [pluginDetails])
  const initialMode = resolveInitialUpdateMode(initialUpdateMode, updateModeOptions)
  const [updateMode, setUpdateMode] = useState<string | undefined>(initialMode)
  const [scraperName, setScraperName] = useState(initialScraperName)
  const supported = supportByPlugin.get(scraperName)
  const supportedIds = allIds.filter((id) => !supported || supported.has(id))
  const [selected, setSelected] = useState<Set<T>>(() =>
    isReplaceUpdateMode(initialMode) ? new Set() : new Set(initialSelected ?? allIds)
  )
  const [missingSelected, setMissingSelected] = useState<Set<T>>(
    () => new Set(initialMissingFields ?? [])
  )
  const [missingFilterEnabled, setMissingFilterEnabled] = useState(
    () => (initialMissingFields?.length ?? 0) > 0
  )
  const [scope, setScope] = useState<S | undefined>(
    () => initialScope ?? scopeOptions?.[0]?.id
  )
  const [auxScope, setAuxScope] = useState<A | undefined>(
    () => initialAuxScope ?? auxScopeOptions?.[0]?.id
  )
  const [matchName, setMatchName] = useState(
    () => initialMatchName ?? matchNameOptions?.[0]?.value ?? ''
  )
  const [useAliases, setUseAliases] = useState(initialUseAliases)
  const [autoCropAvatar, setAutoCropAvatar] = useState(initialAutoCropAvatar)
  const supportedMissingIds = missingIds.filter((id) => !supported || supported.has(id))
  const unsupportedCount = allIds.length - supportedIds.length
  const fieldGroups = useMemo(() => groupFieldOptions(options), [options])
  const missingFieldGroups = useMemo(
    () => groupFieldOptions(missingFieldOptions ?? []),
    [missingFieldOptions]
  )
  const missingFieldLabelById = useMemo(() => {
    const map = new Map<T, string>()
    for (const option of missingFieldOptions ?? []) {
      map.set(option.id, option.label)
    }
    return map
  }, [missingFieldOptions])
  const supportedMissingSet = useMemo(() => new Set(supportedMissingIds), [supportedMissingIds])
  const selectableFieldCount = supported ? supportedIds.length : options.length
  const hasMissingFilter = Boolean(missingFieldOptions && missingFieldOptions.length > 0)
  const effectiveMissingFields = missingFilterEnabled ? [...missingSelected] : []
  const notifyScopeChange = (
    nextScope = scope,
    nextAuxScope = auxScope,
    nextMissingFields: T[] = effectiveMissingFields
  ): void => {
    if (nextScope !== undefined) {
      onScopeChange?.(nextScope, nextMissingFields, nextAuxScope, scraperName)
    }
  }
  const notifyMissingFieldsChange = (nextMissingFields: T[]): void => {
    if (onMissingFieldsChange) {
      onMissingFieldsChange(nextMissingFields, scope, auxScope, scraperName)
      return
    }
    notifyScopeChange(scope, auxScope, nextMissingFields)
  }
  const changeScraperName = (nextScraperName: string): void => {
    setScraperName(nextScraperName)
    if (scope !== undefined) {
      onScopeChange?.(scope, effectiveMissingFields, auxScope, nextScraperName)
    }
  }

  useEffect(() => {
    if (!supported) return
    setSelected((prev) => new Set([...prev].filter((field) => supported.has(field))))
    setMissingSelected((prev) => {
      const next = new Set([...prev].filter((field) => supported.has(field)))
      if (missingFilterEnabled && next.size !== prev.size) {
        const nextFields = [...next]
        if (onMissingFieldsChange) {
          onMissingFieldsChange(nextFields, scope, auxScope, scraperName)
        } else if (scope !== undefined) {
          onScopeChange?.(scope, nextFields, auxScope, scraperName)
        }
      }
      return next
    })
  }, [
    auxScope,
    missingFilterEnabled,
    onMissingFieldsChange,
    onScopeChange,
    scope,
    scraperName,
    supported
  ])

  const toggle = (id: T): void => {
    if (supported && !supported.has(id)) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = (): void => setSelected(new Set(supportedIds))
  const selectNone = (): void => setSelected(new Set())
  const applyUpdateModeSelection = (mode: string): void => {
    if (isReplaceUpdateMode(mode)) {
      selectNone()
      return
    }
    if (mode === 'fillEmpty') {
      selectAll()
    }
  }
  const selectGroup = (groupOptions: ScrapeFieldOption<T>[]): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const opt of groupOptions) {
        if (!supported || supported.has(opt.id)) next.add(opt.id)
      }
      return next
    })
  }
  const clearGroup = (groupOptions: ScrapeFieldOption<T>[]): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const opt of groupOptions) next.delete(opt.id)
      return next
    })
  }
  const setMissing = (next: Set<T>, enabled = missingFilterEnabled): void => {
    setMissingSelected(next)
    if (enabled) {
      notifyMissingFieldsChange([...next])
    }
  }
  const toggleMissing = (id: T): void => {
    if (supported && !supported.has(id)) return
    const next = new Set(missingSelected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setMissing(next)
  }
  const selectAllMissing = (): void => setMissing(new Set(supportedMissingIds))
  const selectNoMissing = (): void => setMissing(new Set())
  const selectMissingFromWriteFields = (): void => {
    const next = new Set([...selected].filter((field) => supportedMissingSet.has(field)))
    setMissing(next, true)
  }
  const handleMissingFilterToggle = (enabled: boolean): void => {
    setMissingFilterEnabled(enabled)
    if (enabled) {
      setMissingSelected(new Set<T>())
    }
    notifyMissingFieldsChange([])
  }

  const renderFieldGroups = (
    groups: ScrapeFieldGroup<T>[],
    selectedSet: Set<T>,
    onToggle: (id: T) => void,
    onSelectGroup: (groupOptions: ScrapeFieldOption<T>[]) => void,
    onClearGroup: (groupOptions: ScrapeFieldOption<T>[]) => void,
    compact = false
  ): JSX.Element => (
    <div className={`${styles.scrapeFieldGroups}${compact ? ` ${styles.scrapeFieldGroupsCompact}` : ''}`}>
      {groups.map((group) => (
        <section className={styles.scrapeFieldGroup} key={group.id}>
          <div className={styles.scrapeFieldGroupHead}>
            <span>{group.label}</span>
            <SegmentedActions size="sm" className={styles.scrapeFieldGroupActions}>
              <SegmentedAction type="button" onClick={() => onSelectGroup(group.options)}>
                全选
              </SegmentedAction>
              <SegmentedAction type="button" onClick={() => onClearGroup(group.options)}>
                清空
              </SegmentedAction>
            </SegmentedActions>
          </div>
          <div className={`${styles.scrapeFieldsList}${compact ? ` ${styles.scrapeFieldsListCompact}` : ''}`}>
            {group.options.map((opt) => (
              <label
                key={opt.id}
                className={`${styles.scrapeFieldOption}${
                  supported && !supported.has(opt.id) ? ` ${styles.scrapeFieldOptionDisabled}` : ''
                }`}
              >
                <Checkbox
                  disabled={Boolean(supported && !supported.has(opt.id))}
                  checked={selectedSet.has(opt.id)}
                  onChange={() => onToggle(opt.id)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </section>
      ))}
    </div>
  )

  const renderMissingFilterGroups = (): JSX.Element => (
    <div className={styles.scrapeMissingFilterGroups}>
      {missingFieldGroups.map((group) => (
        <div className={styles.scrapeMissingFilterGroup} key={group.id}>
          <span className={styles.scrapeMissingFilterGroupTitle}>{group.label}</span>
          <div className={styles.scrapeMissingFilterChips}>
            {group.options.map((opt) => (
              <label
                key={opt.id}
                className={`${styles.scrapeMissingFilterChip}${
                  missingSelected.has(opt.id) ? ` ${styles.isSelected}` : ''
                }${supported && !supported.has(opt.id) ? ` ${styles.isDisabled}` : ''}`}
              >
                <Checkbox
                  disabled={Boolean(supported && !supported.has(opt.id))}
                  checked={missingSelected.has(opt.id)}
                  onChange={() => toggleMissing(opt.id)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )

  const canConfirm =
    selected.size > 0 &&
    scrapers.length > 0 &&
    (!scopeOptions?.length || scope !== undefined) &&
    (!missingFilterEnabled || missingSelected.size > 0)

  const avatarFieldSelected = selected.has('avatar' as T)
  const hasOptionalToggles = showUseAliasesToggle || showAutoCropAvatarToggle
  const scopeLabel = scopeOptionLabel(scopeOptions, scope)
  const auxScopeLabel = scopeOptionLabel(auxScopeOptions, auxScope)
  const updateModeLabel = scopeOptionLabel(updateModeOptions, updateMode)
  const summaryItems: { label: string; value: string }[] = [
    { label: scraperTitle, value: scraperName || (scrapers.length ? '未选择' : '无可用站点') },
    ...(scopeOptions?.length && scopeLabel ? [{ label: scopeTitle, value: scopeLabel }] : []),
    ...(auxScopeOptions?.length && auxScopeLabel
      ? [{ label: auxScopeTitle, value: auxScopeLabel }]
      : []),
    ...(updateModeOptions?.length && updateModeLabel
      ? [{ label: '更新方式', value: updateModeLabel }]
      : []),
    { label: '写入字段', value: `${selected.size}/${selectableFieldCount}` },
    ...(missingFilterEnabled && missingFieldOptions?.length
      ? [
          {
            label: '缺失筛选',
            value:
              missingSelected.size > 0
                ? [...missingSelected]
                    .slice(0, 2)
                    .map((field) => missingFieldLabelById.get(field) ?? field)
                    .join('、') + (missingSelected.size > 2 ? ` 等 ${missingSelected.size} 项` : '')
                : '未选择字段'
          }
        ]
      : []),
    ...(showAutoCropAvatarToggle
      ? [{ label: '头像构图', value: autoCropAvatar && avatarFieldSelected ? '自动' : '关闭' }]
      : [])
  ]

  return (
    <Modal
      title={title}
      hint={hint}

      size="xl"
      className={styles.root}
      onCancel={onCancel}
      actions={
        <>
          <Button type="button" onClick={onCancel}>
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!canConfirm}
            onClick={() =>
              onConfirm(
                [...selected],
                scraperName,
                scope,
                updateMode,
                effectiveMissingFields,
                matchNameOptions?.length ? matchName : undefined,
                showUseAliasesToggle ? useAliases : undefined,
                auxScope,
                showAutoCropAvatarToggle && avatarFieldSelected ? autoCropAvatar : undefined
              )
            }
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className={styles.scrapeModalBody}>
        <div className={styles.scrapeModalSummary} aria-label="本次任务摘要">
          {summaryItems.map((item) => (
            <span className={styles.scrapeModalSummaryItem} key={`${item.label}:${item.value}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>

        <div className={styles.scrapeModalLayout}>
          <aside className={styles.scrapeModalConfigColumn} aria-label="任务配置">
            <section className={styles.scrapeConfigSection}>
              <div className={styles.scrapeConfigSectionHead}>
                <span className={styles.scrapeModalSectionTitle}>{scraperTitle}</span>
                {unsupportedCount > 0 && (
                  <span className={styles.scrapeConfigBadge}>{unsupportedCount} 个字段不支持</span>
                )}
              </div>
              <ScraperSiteSelect
                scrapers={scrapers}
                value={scraperName}
                onChange={changeScraperName}
                title={scraperTitle}
              />
              {unsupportedCount > 0 && (
                <p className={`${styles.hint} ${styles.scrapeModalInlineHint}`}>
                  当前插件不支持 {unsupportedCount} 个字段，相关选项已禁用。
                </p>
              )}
            </section>

            {matchNameOptions && matchNameOptions.length > 0 && (
              <section className={styles.scrapeConfigSection}>
                <span className={styles.scrapeModalSectionTitle}>{matchNameTitle}</span>
                <SelectControl
                  value={matchName}
                  onChange={(e) => setMatchName(e.target.value)}
                  title={matchNameTitle}
                >
                  {matchNameOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {formatActressScrapeMatchNameLabel(opt)}
                    </option>
                  ))}
                </SelectControl>
                {matchNameHint ? <p className={`${styles.hint} ${styles.scrapeModalInlineHint}`}>{matchNameHint}</p> : null}
              </section>
            )}

            {(scopeOptions?.length || auxScopeOptions?.length || hasMissingFilter) && (
              <section className={styles.scrapeConfigSection}>
                <div className={styles.scrapeConfigSectionHead}>
                  <span className={styles.scrapeModalSectionTitle}>目标范围</span>
                  {scopeCountLabel ? (
                    <span className={styles.scrapeScopeCountBadge}>{scopeCountLabel}</span>
                  ) : null}
                </div>
                {scopeOptions && scopeOptions.length > 0 && (
                  <div className={styles.scrapeConfigSubsection}>
                    <span className={styles.scrapeConfigSubtitle}>{scopeTitle}</span>
                    <div className={styles.scrapeModalPills} role="radiogroup" aria-label={scopeTitle}>
                      {scopeOptions.map((opt) => (
                        <label
                          key={String(opt.id)}
                          className={`${styles.scrapeModalPill}${scope === opt.id ? ` ${styles.scrapeModalPillActive}` : ''}`}
                        >
                          <input
                            type="radio"
                            name="rematch-scope"
                            checked={scope === opt.id}
                            onChange={() => {
                              setScope(opt.id)
                              notifyScopeChange(opt.id, auxScope)
                            }}
                          />
                          <span>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {auxScopeOptions && auxScopeOptions.length > 0 && (
                  <div className={styles.scrapeConfigSubsection}>
                    <span className={styles.scrapeConfigSubtitle}>{auxScopeTitle}</span>
                    <div className={styles.scrapeModalPills} role="radiogroup" aria-label={auxScopeTitle}>
                      {auxScopeOptions.map((opt) => (
                        <label
                          key={String(opt.id)}
                          className={`${styles.scrapeModalPill}${auxScope === opt.id ? ` ${styles.scrapeModalPillActive}` : ''}`}
                        >
                          <input
                            type="radio"
                            name="scrape-aux-scope"
                            checked={auxScope === opt.id}
                            onChange={() => {
                              setAuxScope(opt.id)
                              notifyScopeChange(scope, opt.id)
                            }}
                          />
                          <span>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {hasMissingFilter && missingFieldOptions && (
                  <div className={styles.scrapeMissingFilter} data-active={missingFilterEnabled}>
                    <div className={styles.scrapeMissingFilterHead}>
                      <div className={styles.scrapeMissingFilterCopy}>
                        <span className={styles.scrapeConfigSubtitle}>缺失字段筛选</span>
                        <small>{missingFieldHint ?? '只处理缺少任一所选字段的条目'}</small>
                      </div>
                      <SegmentedActions size="sm" className={styles.scrapeMissingFilterMode}>
                        <SegmentedAction
                          type="button"
                          aria-pressed={!missingFilterEnabled}
                          onClick={() => handleMissingFilterToggle(false)}
                        >
                          不限
                        </SegmentedAction>
                        <SegmentedAction
                          type="button"
                          aria-pressed={missingFilterEnabled}
                          onClick={() => handleMissingFilterToggle(true)}
                        >
                          缺任一字段
                        </SegmentedAction>
                      </SegmentedActions>
                    </div>

                    {missingFilterEnabled && (
                      <div className={styles.scrapeMissingFilterBody}>
                        <div className={styles.scrapeMissingFilterToolbar}>
                          <span className={styles.hint}>
                            已选 {missingSelected.size}/{missingFieldOptions.length}
                          </span>
                          <SegmentedActions size="sm" className={styles.missingActions}>
                            <SegmentedAction type="button" onClick={selectMissingFromWriteFields}>
                              按写入字段
                            </SegmentedAction>
                            <SegmentedAction type="button" onClick={selectAllMissing}>
                              全选
                            </SegmentedAction>
                            <SegmentedAction type="button" onClick={selectNoMissing}>
                              清空
                            </SegmentedAction>
                          </SegmentedActions>
                        </div>
                        {renderMissingFilterGroups()}
                        {missingSelected.size === 0 && (
                          <p className={`${styles.hint} ${styles.scrapeModalInlineHint} ${styles.scrapeMissingFilterWarning}`}>
                            请选择至少一个缺失字段，或切回“不限”。
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {updateModeOptions && updateModeOptions.length > 0 && (
              <section className={styles.scrapeConfigSection}>
                <span className={styles.scrapeModalSectionTitle}>更新方式</span>
                <div className={styles.scrapeModeOptions} role="radiogroup" aria-label="更新方式">
                  {updateModeOptions.map((opt) => (
                    <label
                      key={opt.id}
                      className={`${styles.scrapeModeOption}${
                        updateMode === opt.id ? ` ${styles.scrapeModeOptionActive}` : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="scrape-update-mode"
                        checked={updateMode === opt.id}
                        onChange={() => {
                          setUpdateMode(opt.id)
                          applyUpdateModeSelection(opt.id)
                        }}
                      />
                      <span className={styles.scrapeModeOptionCopy}>
                        <span className={styles.scrapeModeOptionTitle}>{opt.label}</span>
                        {opt.description ? (
                          <span className={styles.scrapeModeOptionDesc}>{opt.description}</span>
                        ) : null}
                      </span>
                      <span className={styles.scrapeModeOptionCheck} aria-hidden="true" />
                    </label>
                  ))}
                </div>
                {updateModeHint && !updateModeOptions.some((opt) => opt.description) ? (
                  <p className={`${styles.hint} ${styles.scrapeModalInlineHint}`}>{updateModeHint}</p>
                ) : null}
              </section>
            )}

            {hasOptionalToggles && (
              <section className={styles.scrapeConfigSection}>
                <span className={styles.scrapeModalSectionTitle}>附加选项</span>
                <SettingsToggleList compact className={styles.scrapeModalToggles}>
                  {showUseAliasesToggle && (
                    <SettingsSwitchRow
                      title="使用别名刮削"
                      description={useAliasesHint}
                      checked={useAliases}
                      onChange={setUseAliases}
                    />
                  )}
                  {showAutoCropAvatarToggle && (
                    <SettingsSwitchRow
                      title="自动智能构图头像"
                      description={
                        avatarFieldSelected
                          ? autoCropAvatarHint
                          : '勾选“头像”写入字段后可用。'
                      }
                      checked={autoCropAvatar && avatarFieldSelected}
                      disabled={!avatarFieldSelected}
                      onChange={setAutoCropAvatar}
                    />
                  )}
                </SettingsToggleList>
              </section>
            )}
          </aside>

          <section className={styles.scrapeFieldsPanel} aria-label="写入字段">
            <div className={styles.scrapeFieldsPanelHead}>
              <div>
                <span className={styles.scrapeModalSectionTitle}>写入字段</span>
                <p className={`${styles.hint} ${styles.scrapeFieldsPanelHint}`}>选择本次允许写入的元数据字段。</p>
              </div>
              <div className={`${styles.scrapeFieldsToolbar} ${styles.scrapeFieldsToolbarInline}`}>
                <span className={styles.hint}>
                  已选 {selected.size}/{selectableFieldCount}
                </span>
                <SegmentedActions size="sm">
                  <SegmentedAction type="button" onClick={selectAll}>
                    全选
                  </SegmentedAction>
                  <SegmentedAction type="button" onClick={selectNone}>
                    全不选
                  </SegmentedAction>
                </SegmentedActions>
              </div>
            </div>
            <div className={styles.scrapeFieldsPanelBody}>
              {renderFieldGroups(fieldGroups, selected, toggle, selectGroup, clearGroup, true)}
            </div>
          </section>
        </div>
      </div>
    </Modal>
  )
}
