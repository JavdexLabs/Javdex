import { useEffect, useRef, useState } from 'react'
import type { AiSubtitleCommand, AiSubtitleSnapshot } from '@shared/desktop/aiSubtitles'
import { api } from '../api'

export function useAiSubtitles(sessionId: string | null) {
  const [observed, setState] = useState<AiSubtitleSnapshot | null>(null)
  const [pending, setPending] = useState<AiSubtitleCommand['action'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef({ revision: 0, events: 0, pending: null as AiSubtitleCommand['action'] | null })
  useEffect(() => {
    const counter = request.current
    counter.pending = null
    setPending(null); setError(null); setState(null)
    if (!sessionId) return
    let mounted = true, notified = false
    const unsubscribe = api.playback.onAiSubtitleChanged(value => {
      if (value.sessionId !== null && value.sessionId !== sessionId) return
      notified = true
      if (mounted) { counter.events++; setState(value) }
    })
    void api.playback.aiSubtitleSnapshot().then(value => {
      if (mounted && !notified) setState(value)
    }).catch(() => { if (mounted) setError('无法读取离线字幕状态') })
    return () => { mounted = false; counter.revision++; unsubscribe() }
  }, [sessionId])
  const state = observed?.sessionId && observed.sessionId !== sessionId
    ? { ...observed, sessionId: null, enabled: false, error: null, phase: 'idle' as const,
      activeStart: null, recognizedSeconds: 0, translatedSeconds: 0, recognizedUntil: null, translatedUntil: null, duration: null }
    : observed
  const execute = async (command: AiSubtitleCommand): Promise<boolean> => {
    const counter = request.current
    // Stop may supersede a pending start; other duplicate actions must not race.
    if (!sessionId || counter.pending && !(command.action === 'stop' && counter.pending !== 'stop')) return true
    const revision = ++counter.revision, events = counter.events
    counter.pending = command.action
    setPending(command.action); setError(null)
    try {
      const value = await api.playback.aiSubtitleCommand(sessionId, command)
      if (revision === counter.revision && events === counter.events) setState(value)
      return true
    } catch (cause) {
      if (revision !== counter.revision) return true
      setError(cause instanceof Error ? cause.message : '离线字幕操作失败')
      return false
    } finally {
      if (revision === counter.revision) { counter.pending = null; setPending(null) }
    }
  }
  const enabled = pending === 'start' || pending !== 'stop' && state?.enabled === true && state.sessionId === sessionId
  return { state, pending, busy: pending !== null, error, enabled, execute }
}

export type AiSubtitleController = ReturnType<typeof useAiSubtitles>
