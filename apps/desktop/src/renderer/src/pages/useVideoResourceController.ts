import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { LastVideoResourceRemovalMode, VideoResource, VideoResourceDetail } from '@shared/videoTypes'
import type { VideoLifecycleResult } from '@shared/videoLifecycleTypes'
import { api } from '../api'

interface Options {
  scopeKey: string
  videoId: number
  libraryId: number | null
  notify(message: string, kind: 'success' | 'error' | 'info'): void
  invalidateVideos(): void
  refresh(): void
  leave(): void
}

/** Resource edit/read/delete workflow, scoped to the currently displayed video. */
export function useVideoResourceController({ scopeKey, videoId, libraryId, notify, invalidateVideos, refresh, leave }: Options) {
  const [editResourceTarget, setEditResourceTarget] = useState<VideoResource | null>(null)
  const [moveResourceTarget, setMoveResourceTarget] = useState<VideoResourceDetail | null>(null)
  const [removeResourceTarget, setRemoveResourceTarget] = useState<VideoResourceDetail | null>(null)
  const [removingResource, setRemovingResource] = useState(false)
  const [localResourceLabel, setLocalResourceLabel] = useState('')
  const [savingResource, setSavingResource] = useState(false)
  const savingSession = useRef<number | null>(null)
  const generation = useRef(0)
  const removalInFlight = useRef(false)
  const editorRequest = useRef(0)
  const moveSession = useRef(0)
  useLayoutEffect(() => {
    generation.current += 1
    editorRequest.current += 1
    moveSession.current += 1
    setEditResourceTarget(null)
    setMoveResourceTarget(null)
    setRemoveResourceTarget(null)
    setRemovingResource(false)
    removalInFlight.current = false
    setLocalResourceLabel('')
    setSavingResource(false)
    savingSession.current = null
    return () => { generation.current += 1 }
  }, [scopeKey, videoId, libraryId])

  const closeResourceMove = useCallback(() => {
    moveSession.current += 1
    setMoveResourceTarget(null)
  }, [])
  const closeResourceRemoval = useCallback(() => {
    if (!removalInFlight.current) setRemoveResourceTarget(null)
  }, [])
  const openResourceRemoval = useCallback((resource: VideoResourceDetail) => {
    if (!removalInFlight.current) setRemoveResourceTarget(resource)
  }, [])

  const handleSetPrimaryResource = async (resourceId: number): Promise<void> => {
    if (libraryId == null) return
    const request = generation.current
    try {
      await api.videos.setPrimaryResource(libraryId, videoId, resourceId)
      invalidateVideos()
      if (request !== generation.current) return
      notify('已设为主资源', 'success')
      refresh()
    } catch (e) {
      if (request !== generation.current) return
      notify(String((e as Error).message), 'error')
    }
  }

  const doRemoveResource = async (
    lastResourceMode?: LastVideoResourceRemovalMode
  ): Promise<void> => {
    if (libraryId == null || !removeResourceTarget || removalInFlight.current) return
    const request = generation.current
    removalInFlight.current = true
    setRemovingResource(true)
    try {
      const result = await api.videos.removeResource(
        libraryId,
        videoId,
        removeResourceTarget.id,
        lastResourceMode
      )
      invalidateVideos()
      if (request !== generation.current) return
      const removedSourceFile =
        removeResourceTarget.kind === 'local' || Boolean(removeResourceTarget.strm_source_path)
      const removedStrm = Boolean(removeResourceTarget.strm_source_path)
      setRemoveResourceTarget(null)
      if (result.videoDeleted) {
        notify('影片及全部数据已删除', 'success')
        leave()
      } else if (result.membershipRemoved) {
        notify('资源已移除，影片已自动移出当前媒体库', 'success')
        leave()
      } else {
        notify(
          removedSourceFile
            ? removedStrm
              ? 'STRM 源文件已删除'
              : '本地文件已删除'
            : '链接资源已移除',
          'success'
        )
        refresh()
      }
    } catch (e) {
      if (request !== generation.current) return
      notify(String((e as Error).message), 'error')
    } finally {
      if (request === generation.current) {
        removalInFlight.current = false
        setRemovingResource(false)
      }
    }
  }

  const closeResourceEditor = useCallback(() => {
    editorRequest.current += 1
    savingSession.current = null
    setSavingResource(false)
    setEditResourceTarget(null)
  }, [])

  const readFullResource = async (resourceId: number, editorSession?: number): Promise<VideoResource | null> => {
    if (libraryId == null) return null
    const request = generation.current
    try {
      const resource = await api.videos.getResource(libraryId, videoId, resourceId)
      if (request !== generation.current || (editorSession != null && editorSession !== editorRequest.current)) return null
      if (!resource) notify('资源记录不存在', 'error')
      return resource
    } catch (error) {
      if (request !== generation.current || (editorSession != null && editorSession !== editorRequest.current)) return null
      notify(String((error as Error).message), 'error')
      return null
    }
  }

  const readResourceLocator = async (resourceId: number): Promise<string | null> => {
    return (await readFullResource(resourceId))?.locator ?? null
  }

  const openResourceEditor = async (resource: VideoResourceDetail): Promise<void> => {
    closeResourceEditor()
    const request = ++editorRequest.current
    const fullResource = await readFullResource(resource.id, request)
    if (!fullResource || request !== editorRequest.current) return
    setEditResourceTarget(fullResource)
    setLocalResourceLabel(fullResource.display_name ?? '')
  }

  const openResourceMove = (resource: VideoResourceDetail): void => {
    if (resource.kind === 'local' || resource.strm_source_path) {
      notify(
        '本地与 STRM 资源按来源目录管理，请到当前媒体库设置的“来源”页迁移整个根目录',
        'info'
      )
      return
    }
    moveSession.current += 1
    setMoveResourceTarget(resource)
  }

  // Completion callbacks belong to the rendered modal session, not whichever
  // resource happens to be selected when an older request completes.
  const renderedGeneration = generation.current
  const renderedEditor = editorRequest.current
  const renderedMove = moveSession.current
  const resourceUpdated = (): void => {
    invalidateVideos()
    if (generation.current !== renderedGeneration || editorRequest.current !== renderedEditor) return
    closeResourceEditor()
    notify('资源已更新', 'success')
    refresh()
  }
  const resourceMoved = (result: VideoLifecycleResult): void => {
    invalidateVideos()
    if (generation.current !== renderedGeneration || moveSession.current !== renderedMove) return
    closeResourceMove()
    notify('资源已移动到目标媒体库', 'success')
    if (result.sourceMembershipRemoved) leave()
    else refresh()
  }

  const saveLocalResourceLabel = async (): Promise<void> => {
    if (libraryId == null || !editResourceTarget || editResourceTarget.kind !== 'local') return
    const request = generation.current
    const session = editorRequest.current
    if (savingSession.current === session) return
    savingSession.current = session
    setSavingResource(true)
    try {
      await api.videos.updateLocalResourceLabel(
        libraryId,
        videoId,
        editResourceTarget.id,
        localResourceLabel
      )
      invalidateVideos()
      if (request !== generation.current || session !== editorRequest.current) return
      closeResourceEditor()
      notify('本地资源标签已更新', 'success')
      refresh()
    } catch (error) {
      if (request !== generation.current || session !== editorRequest.current) return
      throw error
    } finally {
      if (request === generation.current && session === editorRequest.current) {
        savingSession.current = null
        setSavingResource(false)
      }
    }
  }
  return {
    editResourceTarget, closeResourceEditor, savingResource, resourceUpdated,
    moveResourceTarget, closeResourceMove, resourceMoved,
    removeResourceTarget, openResourceRemoval, closeResourceRemoval, removingResource,
    localResourceLabel, setLocalResourceLabel, handleSetPrimaryResource, doRemoveResource,
    readResourceLocator, openResourceEditor, openResourceMove, saveLocalResourceLabel
  }
}
