import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, RectangleHorizontal, RectangleVertical } from 'lucide-react'
import {
  PRIVACY_MODE_SCOPES,
  type CoverDisplayMode,
  type PrivacyModeScope,
  type SettingsSnapshot,
  type ThemeId
} from '@shared/settingsTypes'
import {
  MAX_AVATAR_FACE_RATIO,
  MIN_AVATAR_FACE_RATIO,
  normalizeAvatarFaceRatio
} from '@shared/avatarFaceScale'
import type { AvatarCenteringMode } from '@shared/avatarCentering'
import type { PrivacyModeSettings } from '../../privacyMode'
import { THEME_OPTIONS } from '../../theme'
import avatarCompositionLonghairUrl from '../../assets/avatar-composition-longhair.png'
import { createAvatarAnalysisBitmap } from '../../avatarAutoCrop/image'
import {
  readAvatarCompositionPreviewCache,
  writeAvatarCompositionPreviewCache,
  type CachedAvatarCompositionAnalysis
} from '../../avatarAutoCrop/previewCache'
import { analyzeAvatarBitmap } from '../../avatarAutoCrop/service'
import { getCropImageLayout, getSmartAvatarCropTransform } from '../../utils/avatarCrop'
import { useAvatarAutoCropBatch } from '../../contexts/AvatarAutoCropBatchContext'
import ConfirmModal from '../ConfirmModal'
import SettingsSwitchRow from '../SettingsSwitchRow'
import { useTheme } from '../ThemeProvider'
import { useToast } from '../Toast'
import { UI_ICON_SM } from '../iconDefaults'
import { SettingsCard, SettingsHeaderSwitch } from './SettingsPrimitives'
import { useDisplayMode } from '../DisplayModeContext'
import Button from '../Button'
import Switch from '../Switch'

const AVATAR_COMPOSITION_PREVIEW_SIZE = 172

const CENTERING_MODE_OPTIONS: Array<{
  id: AvatarCenteringMode
  label: string
}> = [
  { id: 'face', label: '脸部' },
  { id: 'head', label: '头部' }
]

const PRIVACY_SCOPE_OPTIONS: Array<{
  scope: PrivacyModeScope
  label: string
  description: string
}> = [
  {
    scope: 'covers',
    label: '封面',
    description: '遮盖影片卡片、影片详情页、清单、分类与插件开发选片封面'
  },
  {
    scope: 'actressDefaultAvatar',
    label: '头像',
    description: '使用内置默认头像替换所有真实演员头像'
  },
  {
    scope: 'videoSamples',
    label: '样张',
    description: '遮盖影片详情页中的样张缩略图'
  },
  {
    scope: 'actressGallery',
    label: '写真',
    description: '遮盖演员详情页中的写真缩略图'
  },
  {
    scope: 'globalBackground',
    label: '背景',
    description: '临时隐藏详情背景；关闭后恢复用户原来的背景设置'
  },
  {
    scope: 'imagePreview',
    label: '图片预览',
    description: '禁用封面、头像、样张与写真的全屏图片预览'
  },
  {
    scope: 'mediaEditors',
    label: '图片编辑',
    description: '隐藏影片与清单封面、演员头像的图片编辑模块'
  }
]

type AvatarCompositionDraft = Pick<
  SettingsSnapshot,
  'avatarFaceRatio' | 'avatarCenteringMode' | 'avatarPreserveFullHead'
>

type AppearanceSettingsPatch = Partial<Pick<
  SettingsSnapshot,
  | 'videoDetailUseFirstSampleBackground'
  | 'actressDetailUseFirstGalleryBackground'
  | 'showVideoResourceTypeBadges'
  | 'coverDisplayMode'
  | 'privacyModeEnabled'
  | 'privacyModeScopes'
  | 'avatarFaceRatio'
  | 'avatarCenteringMode'
  | 'avatarPreserveFullHead'
>>

function clonePrivacySettings(settings: PrivacyModeSettings): PrivacyModeSettings {
  return {
    privacyModeEnabled: settings.privacyModeEnabled,
    privacyModeScopes: [...settings.privacyModeScopes]
  }
}

function privacySettingsEqual(a: PrivacyModeSettings, b: PrivacyModeSettings): boolean {
  return (
    a.privacyModeEnabled === b.privacyModeEnabled &&
    a.privacyModeScopes.length === b.privacyModeScopes.length &&
    a.privacyModeScopes.every((scope, index) => scope === b.privacyModeScopes[index])
  )
}

function avatarCompositionDraftFromSettings(settings: SettingsSnapshot): AvatarCompositionDraft {
  return {
    avatarFaceRatio: settings.avatarFaceRatio,
    avatarCenteringMode: settings.avatarCenteringMode,
    avatarPreserveFullHead: settings.avatarPreserveFullHead
  }
}

let pendingAvatarCompositionAnalysis: Promise<CachedAvatarCompositionAnalysis> | null = null

function detectAvatarCompositionSample(): Promise<CachedAvatarCompositionAnalysis> {
  const cached = readAvatarCompositionPreviewCache()
  if (cached) return Promise.resolve(cached)
  if (pendingAvatarCompositionAnalysis) return pendingAvatarCompositionAnalysis

  pendingAvatarCompositionAnalysis = new Promise<CachedAvatarCompositionAnalysis>(
    (resolve, reject) => {
      const image = new Image()
      image.onload = async () => {
        try {
          const bitmap = await createAvatarAnalysisBitmap(image)
          // Always collect the complete geometry once. Centering and protection only
          // change the transform calculated from this cached result.
          const result = await analyzeAvatarBitmap(bitmap, 'head', true)
          const candidate = result.candidates[0]
          if (!candidate) throw new Error('样张中未检测到人脸')
          const analysis: CachedAvatarCompositionAnalysis = {
            imageWidth: image.naturalWidth,
            imageHeight: image.naturalHeight,
            candidate
          }
          writeAvatarCompositionPreviewCache(analysis)
          resolve(analysis)
        } catch (error) {
          reject(error)
        }
      }
      image.onerror = () => reject(new Error('无法加载智能构图样张'))
      image.src = avatarCompositionLonghairUrl
    }
  ).finally(() => {
    pendingAvatarCompositionAnalysis = null
  })

  return pendingAvatarCompositionAnalysis
}

function AvatarCompositionPreview({
  centeringMode,
  faceRatio,
  preserveFullHead
}: {
  centeringMode: AvatarCenteringMode
  faceRatio: number
  preserveFullHead: boolean
}): JSX.Element {
  const [analysis, setAnalysis] = useState<CachedAvatarCompositionAnalysis | null>(() =>
    readAvatarCompositionPreviewCache()
  )
  const [status, setStatus] = useState<'analyzing' | 'ready' | 'error'>(() =>
    analysis ? 'ready' : 'analyzing'
  )

  useEffect(() => {
    if (analysis) return
    let active = true
    setStatus('analyzing')
    void detectAvatarCompositionSample()
      .then((nextAnalysis) => {
        if (!active) return
        setAnalysis(nextAnalysis)
        setStatus('ready')
      })
      .catch((error) => {
        if (!active) return
        console.warn('[AvatarCompositionPreview] failed to analyze sample portrait', error)
        setStatus('error')
      })

    return () => {
      active = false
    }
  }, [analysis])

  const cropLayout = useMemo(() => {
    if (!analysis) return null
    const transform = getSmartAvatarCropTransform(
      analysis.imageWidth,
      analysis.imageHeight,
      analysis.candidate,
      AVATAR_COMPOSITION_PREVIEW_SIZE,
      faceRatio,
      centeringMode,
      preserveFullHead
    )
    return getCropImageLayout(
      analysis.imageWidth,
      analysis.imageHeight,
      transform.baseScale,
      transform.zoom,
      transform.offsetX,
      transform.offsetY,
      AVATAR_COMPOSITION_PREVIEW_SIZE
    )
  }, [analysis, centeringMode, faceRatio, preserveFullHead])

  return (
    <div className="avatar-composition-preview" aria-busy={status === 'analyzing'}>
      <span className="avatar-composition-preview-frame" aria-hidden="true">
        <img
          src={avatarCompositionLonghairUrl}
          alt=""
          draggable={false}
          className={`avatar-composition-preview-image${
            cropLayout ? '' : status === 'error' ? ' is-fallback' : ' is-pending'
          }`}
          style={
            cropLayout
              ? {
                  left: `${cropLayout.left}px`,
                  top: `${cropLayout.top}px`,
                  width: `${cropLayout.width}px`,
                  height: `${cropLayout.height}px`
                }
              : undefined
          }
        />
      </span>
      <span className="avatar-composition-preview-caption" aria-live="polite">
        {centeringMode === 'face' ? '脸部居中' : '头部居中'}
        {status === 'analyzing' ? <span className="avatar-composition-preview-status">检测中…</span> : null}
        {status === 'error' ? <span className="avatar-composition-preview-status is-error">预览不可用</span> : null}
      </span>
    </div>
  )
}

export default function AppearanceSettingsPanel({
  settings,
  theme,
  onThemeChange,
  onPatchSettings,
  onOpenAvatarBatchDetails,
  scrapeBatchActive
}: {
  settings: SettingsSnapshot
  theme: ThemeId
  onThemeChange: (theme: ThemeId) => void
  onPatchSettings: (patch: AppearanceSettingsPatch) => boolean | void | Promise<boolean | void>
  onOpenAvatarBatchDetails: () => void
  scrapeBatchActive: boolean
}): JSX.Element {
  const toast = useToast()
  const { syncPrivacyMode } = useTheme()
  const { mode, setMode, syncResourceTypeBadges } = useDisplayMode()
  const avatarAutoCropBatch = useAvatarAutoCropBatch()
  const [isEditingAvatarComposition, setIsEditingAvatarComposition] = useState(false)
  const [isSavingAvatarComposition, setIsSavingAvatarComposition] = useState(false)
  const [isCountingBatchAvatars, setIsCountingBatchAvatars] = useState(false)
  const [privacyScopesExpanded, setPrivacyScopesExpanded] = useState(false)
  const [batchConfirmCount, setBatchConfirmCount] = useState<number | null>(null)
  const [avatarCompositionDraft, setAvatarCompositionDraft] = useState<AvatarCompositionDraft>(() =>
    avatarCompositionDraftFromSettings(settings)
  )
  const [privacyDraft, setPrivacyDraft] = useState<PrivacyModeSettings>(() =>
    clonePrivacySettings(settings)
  )
  const privacyDraftRef = useRef(privacyDraft)
  const lastPersistedPrivacyRef = useRef(clonePrivacySettings(settings))
  const privacyPersistQueueRef = useRef(Promise.resolve())
  const privacyPersistPendingRef = useRef(0)

  useEffect(() => {
    if (!isEditingAvatarComposition) {
      setAvatarCompositionDraft(avatarCompositionDraftFromSettings(settings))
    }
  }, [isEditingAvatarComposition, settings])

  useEffect(() => {
    if (privacyPersistPendingRef.current > 0) return
    const incoming = clonePrivacySettings(settings)
    lastPersistedPrivacyRef.current = incoming
    if (privacySettingsEqual(privacyDraftRef.current, incoming)) return
    privacyDraftRef.current = incoming
    setPrivacyDraft(incoming)
  }, [settings])

  useEffect(() => {
    if (!privacyDraft.privacyModeEnabled) setPrivacyScopesExpanded(false)
  }, [privacyDraft.privacyModeEnabled])

  const updateAvatarCompositionDraft = (patch: Partial<AvatarCompositionDraft>): void => {
    setAvatarCompositionDraft((current) => ({ ...current, ...patch }))
  }

  const startAvatarCompositionEdit = (): void => {
    setAvatarCompositionDraft(avatarCompositionDraftFromSettings(settings))
    setIsEditingAvatarComposition(true)
  }

  const cancelAvatarCompositionEdit = (): void => {
    setAvatarCompositionDraft(avatarCompositionDraftFromSettings(settings))
    setIsEditingAvatarComposition(false)
  }

  const saveAvatarComposition = async (): Promise<void> => {
    const nextDraft = {
      ...avatarCompositionDraft,
      avatarFaceRatio: normalizeAvatarFaceRatio(avatarCompositionDraft.avatarFaceRatio)
    }
    setIsSavingAvatarComposition(true)
    try {
      const saved = await onPatchSettings(nextDraft)
      if (saved === false) return
      setIsEditingAvatarComposition(false)
    } finally {
      setIsSavingAvatarComposition(false)
    }
  }

  const draftFacePercent = Math.round(avatarCompositionDraft.avatarFaceRatio * 100)
  const batchRunning =
    avatarAutoCropBatch.state.status === 'running' ||
    avatarAutoCropBatch.state.status === 'cancelling'
  const privacyScopes = new Set(privacyDraft.privacyModeScopes)
  const enabledPrivacyScopeCount = PRIVACY_SCOPE_OPTIONS.filter((option) =>
    privacyScopes.has(option.scope)
  ).length

  const persistPrivacyDraft = (next: PrivacyModeSettings): void => {
    const draft = clonePrivacySettings(next)
    privacyDraftRef.current = draft
    setPrivacyDraft(draft)
    syncPrivacyMode(draft)
    privacyPersistPendingRef.current += 1
    privacyPersistQueueRef.current = privacyPersistQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const snapshot = clonePrivacySettings(privacyDraftRef.current)
        const saved = await onPatchSettings({
          privacyModeEnabled: snapshot.privacyModeEnabled,
          privacyModeScopes: snapshot.privacyModeScopes
        })
        if (saved === false) {
          // A newer optimistic toggle may already supersede this snapshot; leave it alone.
          if (!privacySettingsEqual(privacyDraftRef.current, snapshot)) return
          const revert = clonePrivacySettings(lastPersistedPrivacyRef.current)
          privacyDraftRef.current = revert
          setPrivacyDraft(revert)
          syncPrivacyMode(revert)
          return
        }
        lastPersistedPrivacyRef.current = snapshot
      })
      .finally(() => {
        privacyPersistPendingRef.current = Math.max(0, privacyPersistPendingRef.current - 1)
      })
  }

  const togglePrivacyMode = (enabled: boolean): void => {
    setPrivacyScopesExpanded(enabled)
    const current = privacyDraftRef.current
    persistPrivacyDraft({
      privacyModeEnabled: enabled,
      privacyModeScopes:
        enabled && current.privacyModeScopes.length === 0
          ? [...PRIVACY_MODE_SCOPES]
          : [...current.privacyModeScopes]
    })
  }

  const togglePrivacyScope = (scope: PrivacyModeScope, enabled: boolean): void => {
    const nextScopes = new Set(privacyDraftRef.current.privacyModeScopes)
    if (enabled) nextScopes.add(scope)
    else nextScopes.delete(scope)
    persistPrivacyDraft({
      privacyModeScopes: Array.from(nextScopes),
      privacyModeEnabled: nextScopes.size === 0 ? false : privacyDraftRef.current.privacyModeEnabled
    })
  }

  const prepareBatchAvatarCrop = async (): Promise<void> => {
    if (scrapeBatchActive) {
      toast.show('请先完成或终止当前批量刮削任务', 'info')
      return
    }
    setIsCountingBatchAvatars(true)
    try {
      const count = await avatarAutoCropBatch.countAllAvatars()
      if (count === 0) {
        toast.show('当前没有可智能构图的演员头像', 'info')
        return
      }
      setBatchConfirmCount(count)
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setIsCountingBatchAvatars(false)
    }
  }

  const startBatchAvatarCrop = async (): Promise<void> => {
    setBatchConfirmCount(null)
    if (scrapeBatchActive) {
      toast.show('请先完成或终止当前批量刮削任务', 'info')
      return
    }
    try {
      const count = await avatarAutoCropBatch.startAllAvatars()
      if (count === 0) toast.show('当前没有可智能构图的演员头像', 'info')
    } catch (error) {
      toast.show((error as Error).message, 'error')
    }
  }

  const toggleResourceTypeBadges = async (checked: boolean): Promise<void> => {
    const saved = await onPatchSettings({ showVideoResourceTypeBadges: checked })
    if (saved !== false) syncResourceTypeBadges(checked)
  }

  const changeCoverDisplayMode = async (next: CoverDisplayMode): Promise<void> => {
    if (next === mode) return
    const previous = mode
    setMode(next)
    const saved = await onPatchSettings({ coverDisplayMode: next })
    if (saved === false) setMode(previous)
  }

  return (
    <>
      <SettingsCard title="主题" hint="界面配色，立即生效。">
        <div className="theme-grid">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`theme-option theme-option--${option.id}${theme === option.id ? ' active' : ''}`}
              onClick={() => onThemeChange(option.id)}
            >
              <span className={`theme-swatch theme-swatch-${option.id}`} />
              <span className="theme-option-label">{option.label}</span>
              <span className="theme-option-hint">{option.hint}</span>
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title="影片卡片" hint="控制媒体库及其它影片列表中的辅助信息。">
        <div className="settings-toggle-list">
          <SettingsSwitchRow
            title="显示资源类型标签"
            description="最多显示两个类型，其余以 +N 收起"
            checked={settings.showVideoResourceTypeBadges}
            onChange={(checked) => void toggleResourceTypeBadges(checked)}
          />
          <div className="settings-cover-mode-row">
            <span className="settings-cover-mode-copy">
              <span className="settings-cover-mode-title">封面比例</span>
              <span className="settings-cover-mode-description">
                所有媒体库的影片卡片统一使用竖版海报或横版封面
              </span>
            </span>
            <div className="mode-toggle" title="封面显示方式" role="group" aria-label="封面显示方式">
              <button
                type="button"
                className={mode === 'portrait' ? 'active' : undefined}
                aria-pressed={mode === 'portrait'}
                onClick={() => void changeCoverDisplayMode('portrait')}
              >
                <RectangleVertical {...UI_ICON_SM} aria-hidden />
                <span>竖版</span>
              </button>
              <button
                type="button"
                className={mode === 'landscape' ? 'active' : undefined}
                aria-pressed={mode === 'landscape'}
                onClick={() => void changeCoverDisplayMode('landscape')}
              >
                <RectangleHorizontal {...UI_ICON_SM} aria-hidden />
                <span>横版</span>
              </button>
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="智能头像构图"
        hint={
          isEditingAvatarComposition
            ? '设置手动、批量和刮削自动构图使用的居中位置、画面松紧与头部完整性；保存后生效。'
            : '决定手动、批量和刮削自动构图的画面效果；修改设置不会立即重裁已有头像。'
        }
        actions={
          isEditingAvatarComposition ? (
            <>
              <Button
                type="button"
                variant="ghost"

                size="sm"
                disabled={isSavingAvatarComposition}
                onClick={cancelAvatarCompositionEdit}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="primary"

                size="sm"
                disabled={isSavingAvatarComposition}
                onClick={() => void saveAvatarComposition()}
              >
                {isSavingAvatarComposition ? '保存中…' : '保存'}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"

              size="sm"
              onClick={startAvatarCompositionEdit}
            >
              编辑
            </Button>
          )
        }
      >
        <div className="avatar-composition-layout">
          <AvatarCompositionPreview
            centeringMode={avatarCompositionDraft.avatarCenteringMode}
            faceRatio={avatarCompositionDraft.avatarFaceRatio}
            preserveFullHead={avatarCompositionDraft.avatarPreserveFullHead}
          />

          <div
            className={`avatar-composition-controls${
              isEditingAvatarComposition ? ' is-editing' : ' is-readonly'
            }`}
          >
            <div className="avatar-composition-control-row">
              <span className="avatar-composition-control-label">居中基准</span>
              <div
                className="avatar-composition-segmented avatar-composition-segmented--centering"
                role="group"
                aria-label="智能构图居中基准"
              >
                {CENTERING_MODE_OPTIONS.map((option) => {
                  const active = avatarCompositionDraft.avatarCenteringMode === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={active}
                      className={active ? 'active' : undefined}
                      disabled={!isEditingAvatarComposition || isSavingAvatarComposition}
                      onClick={() =>
                        updateAvatarCompositionDraft({ avatarCenteringMode: option.id })
                      }
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="avatar-composition-control-row">
              <span className="avatar-composition-control-label">构图范围</span>
              <div className="avatar-face-ratio-control">
                <div className="avatar-face-ratio-slider-wrap">
                  <input
                    type="range"
                    min={Math.round(MIN_AVATAR_FACE_RATIO * 100)}
                    max={Math.round(MAX_AVATAR_FACE_RATIO * 100)}
                    step={1}
                    value={draftFacePercent}
                    disabled={!isEditingAvatarComposition || isSavingAvatarComposition}
                    aria-label="智能头像构图范围"
                    aria-valuetext={
                      draftFacePercent <= 57
                        ? '宽松'
                        : draftFacePercent >= 68
                          ? '紧凑'
                          : '平衡'
                    }
                    onChange={(event) =>
                      updateAvatarCompositionDraft({
                        avatarFaceRatio: normalizeAvatarFaceRatio(
                          Number(event.target.value) / 100
                        )
                      })
                    }
                  />
                  <span className="avatar-face-ratio-range" aria-hidden="true">
                    <span>更宽松</span>
                    <span>更紧凑</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="avatar-composition-control-row">
              <span className="avatar-composition-control-label">完整头部</span>
              <label className="avatar-head-protection-control">
                <span>必要时缩小画面，避免发顶或下巴被裁切</span>
                <Switch
                  checked={avatarCompositionDraft.avatarPreserveFullHead}
                  disabled={!isEditingAvatarComposition || isSavingAvatarComposition}
                  onChange={(event) =>
                    updateAvatarCompositionDraft({
                      avatarPreserveFullHead: event.target.checked
                    })
                  }
                />
              </label>
            </div>
          </div>
        </div>

        <div className="avatar-auto-crop-batch-row">
          <div className="avatar-auto-crop-batch-copy">
            <strong>批量智能构图</strong>
            <span>
              {batchRunning
                ? avatarAutoCropBatch.state.currentName
                  ? `正在处理 ${avatarAutoCropBatch.state.currentName}`
                  : '正在准备头像原图'
                : avatarAutoCropBatch.state.status === 'done' &&
                    avatarAutoCropBatch.state.total > 0
                  ? `${avatarAutoCropBatch.state.cancelled ? '已停止' : '已完成'}：成功 ${avatarAutoCropBatch.state.success}，失败 ${avatarAutoCropBatch.state.failed}，跳过 ${avatarAutoCropBatch.state.skipped}`
                  : '按当前已保存设置，一次性重新构图所有演员头像。'}
            </span>
          </div>

          {batchRunning ? (
            <div className="avatar-auto-crop-batch-progress" aria-live="polite">
              <progress
                max={Math.max(1, avatarAutoCropBatch.state.total)}
                value={avatarAutoCropBatch.state.current}
                aria-label="批量智能构图进度"
              />
              <span>
                {avatarAutoCropBatch.state.current}/{avatarAutoCropBatch.state.total}
              </span>
              <div className="avatar-auto-crop-batch-actions">
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={onOpenAvatarBatchDetails}
                >
                  查看日志
                </Button>
                {avatarAutoCropBatch.state.source === 'manual' ? (
                  <Button
                    type="button"
                    variant="ghost"

                    size="sm"
                    disabled={avatarAutoCropBatch.state.status === 'cancelling'}
                    onClick={avatarAutoCropBatch.cancel}
                  >
                    {avatarAutoCropBatch.state.status === 'cancelling' ? '正在停止…' : '停止'}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="avatar-auto-crop-batch-actions">
              {avatarAutoCropBatch.state.logs.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={onOpenAvatarBatchDetails}
                >
                  查看日志
                </Button>
              ) : null}
              <Button
                type="button"

                size="sm"
                disabled={
                  isEditingAvatarComposition || isCountingBatchAvatars || scrapeBatchActive
                }
                title={
                  isEditingAvatarComposition
                    ? '请先保存或取消当前构图设置'
                    : scrapeBatchActive
                      ? '请先完成或终止当前批量刮削任务'
                      : undefined
                }
                onClick={() => void prepareBatchAvatarCrop()}
              >
                {isCountingBatchAvatars ? '统计中…' : '构图全部头像'}
              </Button>
            </div>
          )}
        </div>
      </SettingsCard>

      {batchConfirmCount !== null ? (
        <ConfirmModal
          title="批量智能构图"
          confirmText="开始构图"
          onConfirm={() => void startBatchAvatarCrop()}
          onCancel={() => setBatchConfirmCount(null)}
        >
          <p>
            将按当前已保存的智能构图设置处理 {batchConfirmCount} 张演员头像。
            现有手动裁切结果也会被覆盖，此操作无法自动撤销。
          </p>
        </ConfirmModal>
      ) : null}

      <SettingsCard
        title="详情页背景"
        hint="打开详情页时，用库里已有的图片做柔和背景。若你已单独设过背景，会优先保留你的选择。"
      >
        <div className="settings-toggle-list">
          <SettingsSwitchRow
            title="影片详情"
            description="用第一张样张图做背景"
            checked={settings.videoDetailUseFirstSampleBackground}
            onChange={(checked) => onPatchSettings({ videoDetailUseFirstSampleBackground: checked })}
          />
          <SettingsSwitchRow
            title="演员详情"
            description="用第一张写真做背景"
            checked={settings.actressDetailUseFirstGalleryBackground}
            onChange={(checked) => onPatchSettings({ actressDetailUseFirstGalleryBackground: checked })}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        className="privacy-mode-card"
        title="防窥模式"
        hint="遮盖或隐藏敏感图片；仅影响显示，不修改本地文件。"
        actions={
          <SettingsHeaderSwitch
            label="防窥模式"
            checked={privacyDraft.privacyModeEnabled}
            onChange={togglePrivacyMode}
          />
        }
      >
        {privacyDraft.privacyModeEnabled ? (
          <div
            className={`privacy-mode-disclosure${
              privacyScopesExpanded ? ' is-expanded' : ''
            }`}
          >
            <button
              type="button"
              className="privacy-mode-disclosure-trigger"
              aria-expanded={privacyScopesExpanded}
              aria-controls="privacy-mode-scope-list"
              onClick={() => setPrivacyScopesExpanded((expanded) => !expanded)}
            >
              <span className="privacy-mode-disclosure-title">保护范围</span>
              <span className="privacy-mode-disclosure-meta">
                已启用 {enabledPrivacyScopeCount} 项
              </span>
              <ChevronDown
                {...UI_ICON_SM}
                className="privacy-mode-disclosure-chevron"
              />
            </button>
            {privacyScopesExpanded ? (
              <div
                id="privacy-mode-scope-list"
                className="settings-toggle-list privacy-mode-scope-list"
              >
                {PRIVACY_SCOPE_OPTIONS.map((option) => (
                  <SettingsSwitchRow
                    key={option.scope}
                    title={option.label}
                    description={option.description}
                    checked={privacyScopes.has(option.scope)}
                    onChange={(checked) => togglePrivacyScope(option.scope, checked)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsCard>
    </>
  )
}
