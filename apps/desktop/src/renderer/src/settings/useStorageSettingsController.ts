import { useEffect, useRef, useState } from 'react'
import type { SettingsSnapshot } from '@shared/settingsTypes'

type StorageAction = { kind: 'crypto'; enabled: boolean } | { kind: 'relocate'; target: string | null }
type Workflow = { phase: 'idle' } | { phase: 'confirming' | 'running'; action: StorageAction }
export type StoragePatch = Pick<SettingsSnapshot, 'assetEncryption' | 'mediaAssetsPath' | 'mediaAssetsResolvedPath'>

export function useStorageSettingsController({ settings, onSaved, notify, storage }: {
  settings: StoragePatch | null
  onSaved(patch: StoragePatch): void
  notify(message: string, tone: 'success' | 'info' | 'error'): void
  storage: { pickFolder(): Promise<string[]>; setEnabled(enabled: boolean): Promise<StoragePatch>; relocate(target: string | null): Promise<StoragePatch> }
}) {
  const [workflow, setWorkflow] = useState<Workflow>({ phase: 'idle' })
  const live = useRef(true)
  const locked = useRef(false)
  const intent = useRef(0)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const requestEncryption = async (enabled: boolean) => {
    if (!live.current || !settings || locked.current || settings.assetEncryption === enabled) return
    intent.current++
    setWorkflow({ phase: 'confirming', action: { kind: 'crypto', enabled } })
  }
  const requestRelocate = async (targetPath?: string | null) => {
    if (!live.current || !settings || locked.current) return
    const token = ++intent.current
    try {
      const target = targetPath === undefined ? (await storage.pickFolder())[0] : targetPath
      if (!live.current || token !== intent.current || target === undefined) return
      if (target === settings.mediaAssetsResolvedPath || (target === null && !settings.mediaAssetsPath)) {
        notify('已在使用该目录', 'info'); return
      }
      setWorkflow({ phase: 'confirming', action: { kind: 'relocate', target } })
    } catch (error) { if (live.current && token === intent.current) notify((error as Error).message, 'error') }
  }
  const cancel = () => { if (live.current && !locked.current) { intent.current++; setWorkflow({ phase: 'idle' }) } }
  const confirm = async () => {
    if (!live.current || !settings || workflow.phase !== 'confirming' || locked.current) return
    const { action } = workflow
    locked.current = true
    setWorkflow({ phase: 'running', action })
    try {
      const next = action.kind === 'crypto' ? await storage.setEnabled(action.enabled) : await storage.relocate(action.target)
      if (!live.current) return
      onSaved({ assetEncryption: next.assetEncryption, mediaAssetsPath: next.mediaAssetsPath, mediaAssetsResolvedPath: next.mediaAssetsResolvedPath })
      notify(action.kind === 'crypto' ? action.enabled ? '图片加密已开启' : '图片加密已关闭'
        : next.mediaAssetsResolvedPath === settings.mediaAssetsResolvedPath ? '目录未改变' : '图片资源目录已更新', 'success')
      setWorkflow({ phase: 'idle' })
    } catch (error) {
      if (live.current) { setWorkflow({ phase: 'confirming', action }); notify(String((error as Error).message), 'error') }
    } finally { locked.current = false }
  }
  return { action: workflow.phase === 'idle' ? null : workflow.action, busy: workflow.phase === 'running', requestEncryption, requestRelocate, cancel, confirm }
}
