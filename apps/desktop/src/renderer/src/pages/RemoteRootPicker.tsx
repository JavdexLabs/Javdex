import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Folder } from 'lucide-react'
import type { BrowseMediaMountInput, BrowseMediaMountResult } from '@shared/mediaLibraryIpcContract'
import { api } from '../api'
import Button from '../components/Button'
import ConfirmModal from '../components/ConfirmModal'
import { AppFormField } from '../components/FormPrimitives'
import SelectControl from '../components/SelectControl'
import styles from './MediaLibrarySettingsPage.module.css'

const EMPTY_MOUNTS: BrowseMediaMountResult['mounts'] = []

export default function RemoteRootPicker({
  title = '添加服务端来源目录',
  confirmText = '添加此目录',
  busy,
  available,
  onCancel,
  onAdd
}: {
  title?: string
  confirmText?: string
  busy: boolean
  available: boolean
  onCancel: () => void
  onAdd: (selection: { mountSelectionId: string; relativePath: string }, displayPath: string) => void
}): JSX.Element {
  const [mountSelectionId, setMountSelectionId] = useState('')
  const [relativePath, setRelativePath] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(timer)
  }, [search])
  const navigateTo = (nextPath: string): void => {
    setRelativePath(nextPath)
    setSearch('')
    setDebouncedSearch('')
  }
  const mountsQuery = useQuery({
    queryKey: ['media-mounts'],
    queryFn: () => api.mediaLibraries.browseMount({}),
    staleTime: 0,
    refetchOnMount: 'always'
  })
  const mounts = mountsQuery.data?.mounts ?? EMPTY_MOUNTS
  useEffect(() => {
    if (mounts.length === 1 && !mountSelectionId) setMountSelectionId(mounts[0].id)
  }, [mounts, mountSelectionId])
  const browseQuery = useQuery({
    queryKey: ['media-mount', mountSelectionId, relativePath, debouncedSearch],
    queryFn: () => api.mediaLibraries.browseMount({ mountSelectionId, relativePath, search: debouncedSearch } satisfies BrowseMediaMountInput),
    enabled: Boolean(mountSelectionId),
    staleTime: 0,
    refetchOnMount: 'always'
  })
  const current = browseQuery.isError ? null : browseQuery.data?.current
  const segments = relativePath ? relativePath.split('/') : []

  return (
    <ConfirmModal title={title} size="md" confirmText={confirmText} busy={busy}
      confirmDisabled={!available || mountsQuery.isError || !current || browseQuery.isFetching}
      onCancel={onCancel}
      onConfirm={() => current && onAdd({ mountSelectionId: current.mountSelectionId, relativePath: current.relativePath }, current.path)}>
      <div className={styles.remoteRootPicker}>
        <p className={styles.confirmText}>从服务端已配置的媒体挂载中选择目录。这里显示的是服务端路径，不是当前电脑的文件夹。</p>
        {mountsQuery.isError ? (
          <div className={styles.remoteRootMessage} role="alert">挂载列表加载失败。<Button size="sm" onClick={() => void mountsQuery.refetch()}>重试</Button></div>
        ) : mountsQuery.isLoading ? (
          <p className={styles.remoteRootMessage}>正在读取媒体挂载…</p>
        ) : mounts.length === 0 ? (
          <p className={styles.remoteRootMessage}>服务端尚未配置媒体挂载。请先在服务端部署配置中添加 mediaMounts。</p>
        ) : (
          <>
            <AppFormField label="媒体挂载">
              <SelectControl className={styles.remoteRootMountSelect} value={mountSelectionId} onChange={(event) => {
                setMountSelectionId(event.target.value)
                navigateTo('')
              }}>
                <option value="">选择挂载</option>
                {mounts.map((mount) => <option key={mount.id} value={mount.id}>{mount.id} · {mount.path}</option>)}
              </SelectControl>
            </AppFormField>
            <div className={styles.remoteRootBrowser}>
              {mountSelectionId ? (
                <>
                  <nav className={styles.remoteRootBreadcrumbs} aria-label="目录位置">
                    <button type="button" className={styles.remoteRootBreadcrumbButton} onClick={() => navigateTo('')} disabled={busy}>{mountSelectionId}</button>
                    {segments.map((segment, index) => (
                      <span key={`${index}-${segment}`} className={styles.remoteRootBreadcrumbStep}>
                        <ChevronRight size={14} aria-hidden="true" />
                        <button type="button" className={styles.remoteRootBreadcrumbButton} onClick={() => navigateTo(segments.slice(0, index + 1).join('/'))} disabled={busy}>{segment}</button>
                      </span>
                    ))}
                  </nav>
                  <input className={`text-input ${styles.remoteRootSearch}`} type="search" aria-label="筛选当前目录" placeholder="筛选当前目录的子文件夹"
                    value={search} maxLength={100} disabled={busy} onChange={(event) => setSearch(event.target.value)} />
                  <div className={styles.remoteRootDirectoryList} aria-label="子目录">
                    {browseQuery.isLoading || browseQuery.isFetching ? <p className={styles.remoteRootMessage}>正在读取目录…</p> :
                      browseQuery.isError ? <div className={styles.remoteRootMessage} role="alert">目录无法访问。<Button size="sm" onClick={() => void browseQuery.refetch()}>重试</Button></div> :
                      browseQuery.data?.directories.length ? browseQuery.data.directories.map((directory) => (
                        <button key={directory.relativePath} type="button" className={styles.remoteRootDirectory}
                          onClick={() => navigateTo(directory.relativePath)} disabled={busy}>
                          <Folder size={16} aria-hidden="true" />
                          <span className={styles.remoteRootDirectoryName}>{directory.name}</span>
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      )) : <p className={styles.remoteRootMessage}>{debouncedSearch ? '没有匹配的子文件夹。' : '此目录没有子文件夹，可以直接添加。'}</p>}
                  </div>
                  {browseQuery.data?.truncated ? <p className={styles.remoteRootMessage}>仅显示前 500 个子文件夹，可用上方筛选查找其他目录。</p> : null}
                </>
              ) : <p className={styles.remoteRootMessage}>请选择媒体挂载。</p>}
            </div>
            <div className={styles.remoteRootSelection}>
              <span>将添加</span>
              <strong title={current?.path ?? ''}>{current?.path ?? '请先选择目录'}</strong>
            </div>
          </>
        )}
      </div>
    </ConfirmModal>
  )
}
