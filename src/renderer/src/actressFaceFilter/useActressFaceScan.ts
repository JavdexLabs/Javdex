import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActressAvatarFilter, ActressListPage } from '@shared/types'
import { api, assetUrl } from '../api'
import { cancelPendingAvatarAutoCrop } from '../avatarAutoCrop/service'
import { detectActressAvatarFace } from './detect'
import {
  type ActressFaceScanCache,
  type ActressFaceScanStatus
} from './cache'
import {
  scanActressFaceTargets,
  type ActressFaceScanProgress,
  type ActressFaceScanSummary,
  type ActressFaceScanTarget
} from './scanQueue'

export interface ActressFaceScanState {
  progress: ActressFaceScanProgress
  summary: ActressFaceScanSummary | null
}

export interface UseActressFaceScanResult {
  cache: ActressFaceScanCache
  needsScan: boolean
  state: ActressFaceScanState | null
  start: () => Promise<ActressFaceScanSummary | null>
  cancel: () => void
  close: () => void
}

function targetsFromPage(page: ActressListPage): ActressFaceScanTarget[] {
  return page.items.map((item) => ({
    actressId: item.id,
    mainName: item.main_name,
    avatarUrl: assetUrl(item.avatar_path) ?? '',
    fingerprint: item.avatar_fingerprint?.trim() ?? ''
  }))
}

export function useActressFaceScan(): UseActressFaceScanResult {
  const cacheRef = useRef<ActressFaceScanCache>(new Map())
  const mountedRef = useRef(true)
  const runningRef = useRef(false)
  const cancelRequestedRef = useRef(false)
  const runSequenceRef = useRef(0)
  const [needsScan, setNeedsScan] = useState(true)
  const [state, setState] = useState<ActressFaceScanState | null>(null)

  useEffect(
    () => () => {
      mountedRef.current = false
      cancelRequestedRef.current = true
      if (runningRef.current) cancelPendingAvatarAutoCrop()
    },
    []
  )

  const start = useCallback(async (): Promise<ActressFaceScanSummary | null> => {
    if (runningRef.current) return null
    runningRef.current = true
    cancelRequestedRef.current = false
    const runId = ++runSequenceRef.current
    setState({
      progress: {
        total: 0,
        current: 0,
        hasFace: 0,
        withoutFace: 0,
        failed: 0,
        currentName: null,
        reused: 0,
        status: 'running'
      },
      summary: null
    })

    try {
      const page = await api.actresses.listPage({
        gender: 'all',
        status: 'all',
        avatar: 'with',
        sortBy: 'video_count',
        sortDir: 'desc'
      })
      if (!mountedRef.current || runId !== runSequenceRef.current) return null

      const targets = targetsFromPage(page)
      const summary = await scanActressFaceTargets(
        targets,
        cacheRef.current,
        async (target): Promise<ActressFaceScanStatus> => {
          if (!target.avatarUrl) throw new Error('头像图片地址不可用')
          if (!target.fingerprint) throw new Error('头像指纹不可用')
          return detectActressAvatarFace(target)
        },
        () => cancelRequestedRef.current,
        (progress) => {
          if (!mountedRef.current || runId !== runSequenceRef.current) return
          setState((current) => (current ? { ...current, progress } : current))
        }
      )
      if (!mountedRef.current || runId !== runSequenceRef.current) return null
      setState({ progress: { ...lastProgress(summary), status: 'done' }, summary })
      setNeedsScan(summary.cancelled || summary.failed > 0)
      return summary
    } catch (error) {
      if (!mountedRef.current || runId !== runSequenceRef.current) return null
      const message = error instanceof Error ? error.message : String(error)
      const summary: ActressFaceScanSummary = {
        cancelled: false,
        total: 0,
        current: 0,
        hasFace: 0,
        withoutFace: 0,
        failed: 1,
        reused: 0,
        withoutFaceIds: [],
        failures: [{ actressId: 0, mainName: '-', message }]
      }
      setState({
        progress: {
          total: 0,
          current: 0,
          hasFace: 0,
          withoutFace: 0,
          failed: 1,
          currentName: null,
          reused: 0,
          status: 'done'
        },
        summary
      })
      setNeedsScan(true)
      return summary
    } finally {
      if (runId === runSequenceRef.current) {
        runningRef.current = false
        cancelRequestedRef.current = false
      }
    }
  }, [])

  const cancel = useCallback((): void => {
    if (!runningRef.current) return
    cancelRequestedRef.current = true
    setState((current) =>
      current
        ? {
            ...current,
            progress: { ...current.progress, status: 'cancelling' }
          }
        : current
    )
  }, [])

  const close = useCallback((): void => {
    if (runningRef.current) return
    setState(null)
  }, [])

  return { cache: cacheRef.current, needsScan, state, start, cancel, close }
}

function lastProgress(summary: ActressFaceScanSummary): ActressFaceScanProgress {
  return {
    total: summary.total,
    current: summary.current,
    hasFace: summary.hasFace,
    withoutFace: summary.withoutFace,
    failed: summary.failed,
    currentName: null,
    reused: summary.reused,
    status: summary.cancelled ? 'cancelling' : 'done'
  }
}

export function previousAvatarAfterFaceScan(avatar: ActressAvatarFilter): ActressAvatarFilter {
  return avatar === 'without-face' ? 'all' : avatar
}
