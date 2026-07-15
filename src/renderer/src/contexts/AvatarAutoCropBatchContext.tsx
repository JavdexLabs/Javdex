import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createAvatarCropV1, type ActressAvatarCommit } from '@shared/avatarCrop'
import type {
  ActressAvatarAutoCropOutcome,
  ActressAvatarAutoCropRequest,
  ActressAvatarAutoCropTarget,
  ActressListItem,
  BatchLogEntry
} from '@shared/types'
import { api, assetUrl } from '../api'
import { createAvatarAnalysisBitmap } from '../avatarAutoCrop/image'
import { notifyAvatarAutoCropSaved } from '../avatarAutoCrop/events'
import { analyzeAvatarBitmap } from '../avatarAutoCrop/service'
import { useToast } from '../components/Toast'
import { invalidateActressLibraryQueries } from '../query/invalidateLibraryQueries'
import {
  AVATAR_VIEW_SIZE,
  exportAvatarCrop,
  getSmartAvatarCropTransform
} from '../utils/avatarCrop'

export type AvatarAutoCropBatchStatus = 'idle' | 'running' | 'cancelling' | 'done'
export type AvatarAutoCropBatchSource = 'manual'

export interface AvatarAutoCropBatchState {
  status: AvatarAutoCropBatchStatus
  source: AvatarAutoCropBatchSource | null
  total: number
  current: number
  success: number
  failed: number
  skipped: number
  currentName: string | null
  cancelled: boolean
  logs: BatchLogEntry[]
}

interface AvatarAutoCropBatchContextValue {
  state: AvatarAutoCropBatchState
  countAllAvatars: () => Promise<number>
  startAllAvatars: () => Promise<number>
  cancel: () => void
}

const INITIAL_STATE: AvatarAutoCropBatchState = {
  status: 'idle',
  source: null,
  total: 0,
  current: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  currentName: null,
  cancelled: false,
  logs: []
}

const Context = createContext<AvatarAutoCropBatchContextValue | null>(null)

function batchLog(
  code: string,
  level: BatchLogEntry['level'],
  message: string
): BatchLogEntry {
  return {
    time: new Date().toISOString(),
    code,
    level,
    message
  }
}

function avatarTargets(items: ActressListItem[]): ActressAvatarAutoCropTarget[] {
  return items
    .filter((item) => Boolean(item.avatar_source_path || item.avatar_path))
    .map((item) => ({ actressId: item.id, mainName: item.main_name }))
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve(image)
      else reject(new Error('头像原图尺寸无效'))
    }
    image.onerror = () => reject(new Error('无法读取头像原图'))
    image.src = url
  })
}

async function smartCropAvatar(
  target: ActressAvatarAutoCropTarget,
  settings: Awaited<ReturnType<typeof api.settings.get>>
): Promise<'success' | 'skipped'> {
  const sourceInfo = await api.actresses.getAvatarSourceInfo(target.actressId)
  const sourceUrl = assetUrl(sourceInfo?.assetPath)
  if (!sourceInfo || !sourceUrl) return 'skipped'

  const image = await loadImage(sourceUrl)
  const bitmap = await createAvatarAnalysisBitmap(image)
  const analysis = await analyzeAvatarBitmap(
    bitmap,
    settings.avatarCenteringMode,
    settings.avatarPreserveFullHead
  )
  const candidate = analysis.candidates[0]
  if (!candidate) throw new Error('未检测到清晰人脸')
  if (analysis.ambiguous) throw new Error('检测到多张相近人脸，已保留原构图')

  const transform = getSmartAvatarCropTransform(
    image.naturalWidth,
    image.naturalHeight,
    candidate,
    AVATAR_VIEW_SIZE,
    settings.avatarFaceRatio,
    settings.avatarCenteringMode,
    settings.avatarPreserveFullHead
  )
  const displayImageBase64 = exportAvatarCrop(
    image,
    transform.offsetX,
    transform.offsetY,
    transform.zoom,
    transform.baseScale
  )
  if (!displayImageBase64) throw new Error('无法生成裁切头像')

  const commit: ActressAvatarCommit = {
    displayImageBase64,
    crop: createAvatarCropV1({
      sourceFingerprint: sourceInfo.sourceFingerprint,
      zoom: transform.zoom,
      offsetX: transform.offsetX,
      offsetY: transform.offsetY
    })
  }
  if (sourceInfo.requiresSourceAdoption) commit.sourceAssetPath = sourceInfo.assetPath

  await api.actresses.edit(target.actressId, { avatar: commit })
  return 'success'
}

export function AvatarAutoCropBatchProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [state, setState] = useState<AvatarAutoCropBatchState>(INITIAL_STATE)
  const pendingRef = useRef<ActressAvatarAutoCropTarget[]>([])
  const queuedIdsRef = useRef(new Set<number>())
  const runningRef = useRef(false)
  const scrapeCropRunningRef = useRef(false)
  const batchLockTokenRef = useRef<string | null>(null)
  const cancelRequestedRef = useRef(false)
  const sourceRef = useRef<AvatarAutoCropBatchSource | null>(null)
  const totalsRef = useRef({ total: 0, current: 0, success: 0, failed: 0, skipped: 0 })

  const drainQueue = useCallback(async (): Promise<void> => {
    let settings: Awaited<ReturnType<typeof api.settings.get>> | null = null

    try {
      settings = await api.settings.get()
      while (!cancelRequestedRef.current) {
        const target = pendingRef.current.shift()
        if (!target) break

        setState((current) => ({
          ...current,
          status: 'running',
          currentName: target.mainName
        }))

        try {
          const result = await smartCropAvatar(target, settings)
          if (result === 'success') {
            totalsRef.current.success += 1
            notifyAvatarAutoCropSaved(target.actressId)
            setState((current) => ({
              ...current,
              logs: [...current.logs, batchLog(target.mainName, 'success', '智能构图完成')]
            }))
          } else {
            totalsRef.current.skipped += 1
            setState((current) => ({
              ...current,
              logs: [
                ...current.logs,
                batchLog(target.mainName, 'info', '没有可用的头像原图，已跳过')
              ]
            }))
          }
        } catch (error) {
          const errorMessage = (error as Error).message
          totalsRef.current.failed += 1
          setState((current) => ({
            ...current,
            logs: [...current.logs, batchLog(target.mainName, 'error', errorMessage)]
          }))
        } finally {
          totalsRef.current.current += 1
          queuedIdsRef.current.delete(target.actressId)
          setState((current) => ({
            ...current,
            current: totalsRef.current.current,
            success: totalsRef.current.success,
            failed: totalsRef.current.failed,
            skipped: totalsRef.current.skipped
          }))
        }
      }
    } catch (error) {
      const unprocessed = pendingRef.current.length
      totalsRef.current.failed += unprocessed
      totalsRef.current.current += unprocessed
      pendingRef.current = []
      queuedIdsRef.current.clear()
      setState((current) => ({
        ...current,
        logs: [
          ...current.logs,
          batchLog('-', 'error', `批量构图中断：${(error as Error).message}`)
        ]
      }))
    } finally {
      const cancelled = cancelRequestedRef.current
      const batchLockToken = batchLockTokenRef.current
      if (batchLockToken) {
        try {
          await api.avatarAutoCropBatch.end(batchLockToken)
        } catch (error) {
          toast.show(`无法释放批量构图任务锁：${(error as Error).message}`, 'error')
        } finally {
          batchLockTokenRef.current = null
        }
      }
      pendingRef.current = []
      queuedIdsRef.current.clear()
      runningRef.current = false
      cancelRequestedRef.current = false
      sourceRef.current = null
      if (totalsRef.current.success > 0) invalidateActressLibraryQueries(queryClient)
      setState((current) => ({
        ...current,
        status: 'done',
        current: totalsRef.current.current,
        success: totalsRef.current.success,
        failed: totalsRef.current.failed,
        skipped: totalsRef.current.skipped,
        currentName: null,
        cancelled,
        logs: [
          ...current.logs,
          batchLog(
            '-',
            cancelled ? 'info' : totalsRef.current.failed > 0 ? 'error' : 'success',
            `${cancelled ? '批量构图已停止' : '批量构图已完成'}：成功 ${totalsRef.current.success}，失败 ${totalsRef.current.failed}，跳过 ${totalsRef.current.skipped}`
          )
        ]
      }))

      const result = totalsRef.current
      toast.show(
        cancelled
          ? `已停止批量构图，完成 ${result.success}/${result.total} 张头像`
          : `批量构图完成：成功 ${result.success}，失败 ${result.failed}`,
        result.failed > 0 ? 'info' : 'success'
      )
    }
  }, [queryClient, toast])

  const startQueue = useCallback(
    (targets: ActressAvatarAutoCropTarget[]): void => {
      pendingRef.current = targets
      queuedIdsRef.current = new Set(targets.map((target) => target.actressId))
      runningRef.current = true
      cancelRequestedRef.current = false
      sourceRef.current = 'manual'
      totalsRef.current = {
        total: targets.length,
        current: 0,
        success: 0,
        failed: 0,
        skipped: 0
      }
      setState({
        status: 'running',
        source: 'manual',
        total: targets.length,
        current: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        currentName: null,
        cancelled: false,
        logs: [
          batchLog(
            '-',
            'info',
            `开始批量智能构图，共 ${targets.length} 张头像`
          )
        ]
      })
      void drainQueue()
    },
    [drainQueue]
  )

  const cropScrapedAvatar = useCallback(
    async (request: ActressAvatarAutoCropRequest): Promise<ActressAvatarAutoCropOutcome> => {
      if (runningRef.current) {
        return { status: 'failed', message: '正在执行“构图全部头像”，请稍后重试' }
      }
      if (scrapeCropRunningRef.current) {
        return { status: 'failed', message: '已有演员头像正在智能构图' }
      }

      scrapeCropRunningRef.current = true
      try {
        const settings = await api.settings.get()
        const result = await smartCropAvatar(request, settings)
        if (result === 'skipped') {
          return { status: 'skipped', message: '没有可用的头像原图' }
        }
        notifyAvatarAutoCropSaved(request.actressId)
        invalidateActressLibraryQueries(queryClient)
        return { status: 'success' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toast.show(`头像自动构图失败：${request.mainName}：${message}`, 'error')
        return { status: 'failed', message }
      } finally {
        scrapeCropRunningRef.current = false
      }
    },
    [queryClient, toast]
  )

  useEffect(
    () => api.actressScrape.onAvatarAutoCropRequest(cropScrapedAvatar),
    [cropScrapedAvatar]
  )

  useEffect(
    () => () => {
      const batchLockToken = batchLockTokenRef.current
      if (!batchLockToken) return
      batchLockTokenRef.current = null
      void api.avatarAutoCropBatch.end(batchLockToken).catch(() => undefined)
    },
    []
  )

  const listAllAvatarTargets = useCallback(async (): Promise<ActressAvatarAutoCropTarget[]> => {
    return avatarTargets(await api.actresses.list(undefined, 'all'))
  }, [])

  const countAllAvatars = useCallback(async (): Promise<number> => {
    return (await listAllAvatarTargets()).length
  }, [listAllAvatarTargets])

  const startAllAvatars = useCallback(async (): Promise<number> => {
    if (runningRef.current) throw new Error('已有头像智能构图任务正在进行')
    if (scrapeCropRunningRef.current) throw new Error('请等待当前演员头像智能构图完成')
    const targets = await listAllAvatarTargets()
    if (targets.length === 0) return 0

    const batchLockToken = await api.avatarAutoCropBatch.begin()
    batchLockTokenRef.current = batchLockToken
    try {
      startQueue(targets)
    } catch (error) {
      batchLockTokenRef.current = null
      await api.avatarAutoCropBatch.end(batchLockToken).catch(() => undefined)
      throw error
    }
    return targets.length
  }, [listAllAvatarTargets, startQueue])

  const cancel = useCallback((): void => {
    if (!runningRef.current || sourceRef.current !== 'manual') return
    cancelRequestedRef.current = true
    pendingRef.current = []
    setState((current) => ({
      ...current,
      status: 'cancelling',
      logs: [...current.logs, batchLog('-', 'info', '已请求停止，将在当前头像处理完成后结束')]
    }))
  }, [])

  const value = useMemo<AvatarAutoCropBatchContextValue>(
    () => ({ state, countAllAvatars, startAllAvatars, cancel }),
    [cancel, countAllAvatars, startAllAvatars, state]
  )

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useAvatarAutoCropBatch(): AvatarAutoCropBatchContextValue {
  const context = useContext(Context)
  if (!context) {
    throw new Error('useAvatarAutoCropBatch must be used within AvatarAutoCropBatchProvider')
  }
  return context
}
