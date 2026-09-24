import { appendAvatarLog, type AvatarLogState } from '../avatarAutoCrop/logs'
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
import type { ActressAvatarAutoCropOutcome, ActressAvatarAutoCropRequest, ActressAvatarAutoCropTarget, ActressAvatarCropTargetPage } from '@shared/actressAvatarCropTypes'
import type { BatchLogEntry } from '@shared/batchScrapeTypes'
import { api, assetUrl } from '../api'
import { createAvatarAnalysisBitmap, loadAvatarAnalysisImage } from '../avatarAutoCrop/image'
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

export interface AvatarAutoCropBatchState extends AvatarLogState {
  status: AvatarAutoCropBatchStatus
  source: AvatarAutoCropBatchSource | null
  total: number
  current: number
  success: number
  failed: number
  skipped: number
  currentName: string | null
  cancelled: boolean
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
  logs: [],
  totalLogCount: 0,
  shortenedLogCount: 0
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

async function smartCropAvatar(
  target: ActressAvatarAutoCropTarget,
  settings: Awaited<ReturnType<typeof api.settings.get>>
): Promise<'success' | 'skipped'> {
  const sourceInfo = await api.actresses.getAvatarSourceInfo(target.actressId)
  const sourceUrl = assetUrl(sourceInfo?.assetPath)
  if (!sourceInfo || !sourceUrl) return 'skipped'

  const image = await loadAvatarAnalysisImage(sourceUrl)
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
  const nextAfterIdRef = useRef<number | null>(null)
  const runningRef = useRef(false)
  const startingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
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
        if (pendingRef.current.length === 0 && nextAfterIdRef.current !== null) {
          const token = batchLockTokenRef.current
          if (!token) throw new Error('头像任务令牌已失效')
          const page = await api.avatarAutoCropBatch.targets(token, nextAfterIdRef.current)
          if (cancelRequestedRef.current) break
          pendingRef.current = page.items.slice().reverse()
          nextAfterIdRef.current = page.nextAfterId
        }
        const target = pendingRef.current.pop()
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
              ...appendAvatarLog(current, batchLog(target.mainName, 'success', '智能构图完成'))
            }))
          } else {
            totalsRef.current.skipped += 1
            setState((current) => ({
              ...current,
              ...appendAvatarLog(current, batchLog(target.mainName, 'info', '没有可用的头像原图，已跳过'))
            }))
          }
        } catch (error) {
          const errorMessage = (error as Error).message
          totalsRef.current.failed += 1
          setState((current) => ({
            ...current,
            ...appendAvatarLog(current, batchLog(target.mainName, 'error', errorMessage))
          }))
        } finally {
          totalsRef.current.current += 1
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
      if (!cancelRequestedRef.current) {
        const unprocessed = totalsRef.current.total - totalsRef.current.current
        totalsRef.current.failed += unprocessed
        totalsRef.current.current += unprocessed
        setState((current) => ({
          ...current,
          ...appendAvatarLog(current, batchLog('-', 'error', `批量构图中断：${(error as Error).message}；${unprocessed} 项未处理，计入失败`))
        }))
      }
      pendingRef.current = []
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
      nextAfterIdRef.current = null
      runningRef.current = false
      cancelRequestedRef.current = false
      sourceRef.current = null
      if (totalsRef.current.success > 0) void invalidateActressLibraryQueries(queryClient)
      setState((current) => ({
        ...current,
        status: 'done',
        current: totalsRef.current.current,
        success: totalsRef.current.success,
        failed: totalsRef.current.failed,
        skipped: totalsRef.current.skipped,
        currentName: null,
        cancelled,
        ...appendAvatarLog(current, batchLog(
            '-',
            cancelled ? 'info' : totalsRef.current.failed > 0 ? 'error' : 'success',
            `${cancelled ? '批量构图已停止' : '批量构图已完成'}：成功 ${totalsRef.current.success}，失败 ${totalsRef.current.failed}，跳过 ${totalsRef.current.skipped}`
          ))
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
    (page: ActressAvatarCropTargetPage): void => {
      // Only one page is retained; pop preserves the server's processing order.
      pendingRef.current = page.items.slice().reverse()
      nextAfterIdRef.current = page.nextAfterId
      runningRef.current = true
      cancelRequestedRef.current = false
      sourceRef.current = 'manual'
      totalsRef.current = {
        total: page.total,
        current: 0,
        success: 0,
        failed: 0,
        skipped: 0
      }
      setState({
        status: 'running',
        source: 'manual',
        total: page.total,
        current: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        currentName: null,
        cancelled: false,
        ...appendAvatarLog(INITIAL_STATE, batchLog(
            '-',
            'info',
            `开始批量智能构图，共 ${page.total} 张头像`
          ))
      })
      void drainQueue()
    },
    [drainQueue]
  )

  const cropScrapedAvatar = useCallback(
    async (request: ActressAvatarAutoCropRequest): Promise<ActressAvatarAutoCropOutcome> => {
      if (runningRef.current || startingRef.current) {
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
        void invalidateActressLibraryQueries(queryClient)
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
      if (runningRef.current) {
        cancelRequestedRef.current = true
        pendingRef.current = []
        // The in-flight operation owns the lock until drainQueue finally settles.
        return
      }
      const batchLockToken = batchLockTokenRef.current
      if (!batchLockToken) return
      batchLockTokenRef.current = null
      void api.avatarAutoCropBatch.end(batchLockToken).catch(() => undefined)
    },
    []
  )

  const countAllAvatars = useCallback(async (): Promise<number> => {
    return api.actresses.countAvatarCropTargets()
  }, [])

  const startAllAvatars = useCallback(async (): Promise<number> => {
    if (runningRef.current || startingRef.current) throw new Error('已有头像智能构图任务正在进行')
    if (scrapeCropRunningRef.current) throw new Error('请等待当前演员头像智能构图完成')
    startingRef.current = true
    let token: string | null = null
    let handedOff = false
    try {
      token = await api.avatarAutoCropBatch.begin()
      if (!mountedRef.current) {
        await api.avatarAutoCropBatch.end(token)
        return 0
      }
      batchLockTokenRef.current = token
      const page = await api.avatarAutoCropBatch.targets(token, 0)
      if (!mountedRef.current || page.total === 0) return 0
      startQueue(page)
      handedOff = true
      return page.total
    } finally {
      startingRef.current = false
      if (!handedOff && token && batchLockTokenRef.current === token) {
        batchLockTokenRef.current = null
        await api.avatarAutoCropBatch.end(token)
      }
    }
  }, [startQueue])

  const cancel = useCallback((): void => {
    if (!runningRef.current || sourceRef.current !== 'manual') return
    cancelRequestedRef.current = true
    pendingRef.current = []
    setState((current) => ({
      ...current,
      status: 'cancelling',
      ...appendAvatarLog(current, batchLog('-', 'info', '已请求停止，将在当前头像处理完成后结束'))
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
