import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ActressAvatarFilter, ActressListPage } from '@shared/types'
import { api, assetUrl } from '../api'
import { cancelPendingAvatarAutoCrop } from '../avatarAutoCrop/service'
import { detectActressAvatarFace } from './detect'
import { type ActressFaceScanCache, type ActressFaceScanStatus } from './cache'
import {
  getActressFaceScanSession,
  getActressFaceScanSessionRevision,
  subscribeActressFaceScanSession,
  updateActressFaceScanSession
} from './session'
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
  running: boolean
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
  useSyncExternalStore(
    subscribeActressFaceScanSession,
    getActressFaceScanSessionRevision,
    getActressFaceScanSessionRevision
  )
  const session = getActressFaceScanSession()
  const cache = session.cache
  const mountedRef = useRef(true)
  const [state, setState] = useState<ActressFaceScanState | null>(null)

  const setNeedsScan = useCallback((value: boolean): void => {
    updateActressFaceScanSession({ needsScan: value })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Cancel an in-flight scan when leaving the page; completed cache entries remain.
      if (getActressFaceScanSession().running) {
        updateActressFaceScanSession({ cancelRequested: true })
        cancelPendingAvatarAutoCrop()
      }
    }
  }, [])

  const start = useCallback(async (): Promise<ActressFaceScanSummary | null> => {
    const currentSession = getActressFaceScanSession()
    if (currentSession.running) return null
    const runId = currentSession.runSequence + 1
    updateActressFaceScanSession({
      running: true,
      cancelRequested: false,
      runSequence: runId
    })
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
      if (runId !== getActressFaceScanSession().runSequence) return null

      const targets = targetsFromPage(page)
      const summary = await scanActressFaceTargets(
        targets,
        cache,
        async (target): Promise<ActressFaceScanStatus> => {
          if (!target.avatarUrl) throw new Error('头像图片地址不可用')
          if (!target.fingerprint) throw new Error('头像指纹不可用')
          return detectActressAvatarFace(target)
        },
        () => getActressFaceScanSession().cancelRequested,
        (progress) => {
          if (!mountedRef.current || runId !== getActressFaceScanSession().runSequence) return
          setState((current) => (current ? { ...current, progress } : current))
        }
      )
      if (runId !== getActressFaceScanSession().runSequence) return null
      // Persist completeness even if the actresses page unmounted during the run.
      setNeedsScan(summary.cancelled || summary.failed > 0)
      if (!mountedRef.current) return summary
      setState({ progress: { ...lastProgress(summary), status: 'done' }, summary })
      return summary
    } catch (error) {
      if (runId !== getActressFaceScanSession().runSequence) return null
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
      setNeedsScan(true)
      if (!mountedRef.current) return summary
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
      return summary
    } finally {
      if (runId === getActressFaceScanSession().runSequence) {
        updateActressFaceScanSession({ running: false, cancelRequested: false })
      }
    }
  }, [cache, setNeedsScan])

  const cancel = useCallback((): void => {
    if (!getActressFaceScanSession().running) return
    updateActressFaceScanSession({ cancelRequested: true })
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
    if (getActressFaceScanSession().running) return
    setState(null)
  }, [])

  return {
    cache,
    needsScan: session.needsScan,
    running: session.running,
    state,
    start,
    cancel,
    close
  }
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
