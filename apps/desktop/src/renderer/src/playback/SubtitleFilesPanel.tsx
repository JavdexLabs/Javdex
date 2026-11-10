import { useCallback, useEffect, useRef, useState } from 'react'
import { Captions, Plus, RefreshCw } from 'lucide-react'
import type { PlaybackTarget } from '@shared/desktop/playback'
import type { SubtitleFilesSnapshot } from '@shared/desktop/subtitleTasks'
import { api } from '../api'
import Button from '../components/Button'
import IconButton from '../components/IconButton'
import EmptyState from '../components/EmptyState'
import styles from './SubtitleFilesPanel.module.css'

export default function SubtitleFilesPanel({ target }: { target: PlaybackTarget }): JSX.Element {
  const [snapshot, setSnapshot] = useState<SubtitleFilesSnapshot | null>(null)
  const [loading, setLoading] = useState(true), [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null)
  const mounted = useRef(true), sequence = useRef(0), locked = useRef(false)
  const load = useCallback(async (): Promise<void> => {
    if (locked.current) return
    const request = ++sequence.current
    setLoading(true); setError(null)
    try {
      const value = await api.playback.subtitleFiles(target)
      if (mounted.current && request === sequence.current) setSnapshot(value)
    } catch (cause) {
      if (mounted.current && request === sequence.current) setError(cause instanceof Error ? cause.message : '无法读取字幕文件')
    } finally { if (mounted.current && request === sequence.current) setLoading(false) }
  }, [target])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])
  const associate = async (): Promise<void> => {
    if (locked.current) return
    locked.current = true; sequence.current++; setAdding(true); setError(null); setMessage(null)
    try {
      const value = await api.playback.associateSubtitleFiles(target)
      if (mounted.current && value) { setSnapshot(value); setMessage('字幕已关联，下次播放会自动加载。') }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '关联字幕失败')
    } finally { locked.current = false; if (mounted.current) { setAdding(false); setLoading(false) } }
  }
  return <section className={styles.root} aria-label="影片字幕文件">
    <div className={styles.toolbar}>
      <span className={styles.count}>{loading ? '正在读取…' : snapshot ? `${snapshot.files.length} 个字幕文件` : '字幕文件'}</span>
      <div className={styles.actions}>
        <IconButton icon={<RefreshCw size={15} />} label="刷新字幕文件" size="sm" disabled={loading || adding} onClick={() => { setMessage(null); void load() }} />
        <Button size="sm" busy={adding} disabled={loading} onClick={() => void associate()}><Plus size={14} />关联字幕文件</Button>
      </div>
    </div>
    <p className={styles.note}>包含同目录自动发现和已关联的 SRT / ASS 字幕。关联保留原文件位置，不复制或移动文件。</p>
    {(error || snapshot?.error) && <p className={styles.error} role="alert">{error || snapshot?.error}</p>}
    {message && <p className={styles.message} role="status">{message}</p>}
    {loading && !snapshot ? <EmptyState variant="compact" loading title="正在读取字幕文件…" /> :
      snapshot?.files.length ? <div className={styles.list}>
        {snapshot.files.map(file => <article className={styles.file} key={file.path} aria-label={file.name}>
          <Captions size={18} className={styles.icon} />
          <div className={styles.content}>
            <div className={styles.fileHead}><strong>{file.name}</strong><span className={styles.source}>{file.source === 'directory' ? '同目录' : '已关联'}</span></div>
            <p className={styles.path}>{file.path}</p>
            {file.error && <p className={styles.error}>{file.error}</p>}
          </div>
          <span className={styles.availability} data-unavailable={!file.available}>{file.available ? '可用' : '不可用'}</span>
        </article>)}
      </div> : !error && !snapshot?.error ? <EmptyState variant="compact" icon={<Captions size={24} />} title="暂无字幕文件" description="可以关联已有字幕，或切换到「AI 生成」创建字幕。" /> : null}
    <p className={styles.note}>关联记录保存在本机。下次播放自动加载，已有字幕选择和关闭状态保持不变。</p>
  </section>
}
