import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, ThemeId } from '@shared/types'
import {
  MAX_AVATAR_FACE_RATIO,
  MIN_AVATAR_FACE_RATIO,
  normalizeAvatarFaceRatio
} from '@shared/avatarFaceScale'
import type { AvatarCenteringMode } from '@shared/avatarCentering'
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
import { useToast } from '../Toast'
import { SettingsCard } from './SettingsPrimitives'

const AVATAR_COMPOSITION_PREVIEW_SIZE = 172

const CENTERING_MODE_OPTIONS: Array<{
  id: AvatarCenteringMode
  label: string
}> = [
  { id: 'face', label: '脸部' },
  { id: 'head', label: '头部' }
]

type AvatarCompositionDraft = Pick<
  AppSettings,
  'avatarFaceRatio' | 'avatarCenteringMode' | 'avatarPreserveFullHead'
>

function avatarCompositionDraftFromSettings(settings: AppSettings): AvatarCompositionDraft {
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
  settings: AppSettings
  theme: ThemeId
  onThemeChange: (theme: ThemeId) => void
  onPatchSettings: (patch: Partial<AppSettings>) => boolean | void | Promise<boolean | void>
  onOpenAvatarBatchDetails: () => void
  scrapeBatchActive: boolean
}): JSX.Element {
  const toast = useToast()
  const avatarAutoCropBatch = useAvatarAutoCropBatch()
  const [isEditingAvatarComposition, setIsEditingAvatarComposition] = useState(false)
  const [isSavingAvatarComposition, setIsSavingAvatarComposition] = useState(false)
  const [isCountingBatchAvatars, setIsCountingBatchAvatars] = useState(false)
  const [batchConfirmCount, setBatchConfirmCount] = useState<number | null>(null)
  const [avatarCompositionDraft, setAvatarCompositionDraft] = useState<AvatarCompositionDraft>(() =>
    avatarCompositionDraftFromSettings(settings)
  )

  useEffect(() => {
    if (!isEditingAvatarComposition) {
      setAvatarCompositionDraft(avatarCompositionDraftFromSettings(settings))
    }
  }, [
    isEditingAvatarComposition,
    settings.avatarCenteringMode,
    settings.avatarFaceRatio,
    settings.avatarPreserveFullHead
  ])

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
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={isSavingAvatarComposition}
                onClick={cancelAvatarCompositionEdit}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={isSavingAvatarComposition}
                onClick={() => void saveAvatarComposition()}
              >
                {isSavingAvatarComposition ? '保存中…' : '保存'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={startAvatarCompositionEdit}
            >
              编辑
            </button>
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
                <span className="ui-switch">
                  <input
                    type="checkbox"
                    checked={avatarCompositionDraft.avatarPreserveFullHead}
                    disabled={!isEditingAvatarComposition || isSavingAvatarComposition}
                    onChange={(event) =>
                      updateAvatarCompositionDraft({
                        avatarPreserveFullHead: event.target.checked
                      })
                    }
                  />
                  <span className="ui-switch-slider" />
                </span>
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
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={onOpenAvatarBatchDetails}
                >
                  查看日志
                </button>
                {avatarAutoCropBatch.state.source === 'manual' ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={avatarAutoCropBatch.state.status === 'cancelling'}
                    onClick={avatarAutoCropBatch.cancel}
                  >
                    {avatarAutoCropBatch.state.status === 'cancelling' ? '正在停止…' : '停止'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="avatar-auto-crop-batch-actions">
              {avatarAutoCropBatch.state.logs.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={onOpenAvatarBatchDetails}
                >
                  查看日志
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-sm"
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
              </button>
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
    </>
  )
}
