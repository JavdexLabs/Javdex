import { useEffect, useState } from 'react'
import { Copy, FolderOpen, AlertCircle } from 'lucide-react'
import type { ManualImportResult } from '@shared/libraryTypes'
import type { Video, VideoResourceImportTarget } from '@shared/videoTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import { api } from '../../api'
import { normalizeOptionalVideoCode } from '../videoResourceImportForm'
import { useToast } from '../Toast'
import Button from '../Button'
import IconButton from '../IconButton'
import SelectControl from '../SelectControl'
import { UI_ICON_SM } from '../iconDefaults'
import styles from './UnrecognizedRow.module.css'

/** One editable resolution card in the audit list: manual import or rename on disk. */
export default function UnrecognizedRow({
  path: filePath,
  onResolved
}: {
  path: string
  onResolved: (oldPath: string) => void
}): JSX.Element {
  const toast = useToast()
  const fullName = filePath.split(/[\\/]/).pop() || filePath
  const dot = fullName.lastIndexOf('.')
  const baseName = dot > 0 ? fullName.slice(0, dot) : fullName
  const ext = dot > 0 ? fullName.slice(dot) : ''
  const [code, setCode] = useState('')
  const [renameBase, setRenameBase] = useState(baseName)
  const [busy, setBusy] = useState<'import' | 'rename' | null>(null)
  const [targetValue, setTargetValue] = useState('')
  const [matchingVideos, setMatchingVideos] = useState<Array<Pick<Video, 'id' | 'code' | 'title'>>>([])
  const [loadingTargets, setLoadingTargets] = useState(false)

  const codeTrimmed = code.trim()
  const renameTrimmed = renameBase.trim()
  const canImport = codeTrimmed.length > 0 && targetValue.length > 0
  const canRename = renameTrimmed.length > 0 && renameTrimmed !== baseName && canImport

  useEffect(() => {
    const normalized = normalizeOptionalVideoCode(code)
    setTargetValue('')
    if (!normalized) {
      setMatchingVideos([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoadingTargets(true)
      void api.videos
        .list({ search: normalized, limit: 100, offset: 0 })
        .then((result) => {
          if (!cancelled) {
            setMatchingVideos(
              result.items.filter((video) => normalizeVideoCode(video.code) === normalized)
            )
          }
        })
        .catch((error) => {
          if (!cancelled) toast.show(String((error as Error).message), 'error')
        })
        .finally(() => {
          if (!cancelled) setLoadingTargets(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, toast])

  const finishImport = (res: ManualImportResult): void => {
    if (res.imported) {
      toast.show(
        res.relocated ? `已导入（番号已存在，已更新路径）：${res.code}` : `已导入：${res.code}`,
        'success'
      )
      onResolved(filePath)
      return
    }
    if (res.skippedPath) {
      toast.show('该文件路径已在媒体库中', 'info')
      onResolved(filePath)
      return
    }
    toast.show(`番号「${res.code}」已存在且原文件仍在，未重复导入`, 'info')
  }

  const selectedTarget = (): VideoResourceImportTarget =>
    targetValue === 'new'
      ? { kind: 'new' }
      : { kind: 'existing', videoId: Number(targetValue.slice('existing:'.length)) }

  const doManualImport = async (): Promise<void> => {
    if (busy || !canImport) return
    setBusy('import')
    try {
      finishImport(await api.scan.importManual(filePath, codeTrimmed, selectedTarget()))
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setBusy(null)
    }
  }

  const doRename = async (): Promise<void> => {
    if (busy || !canRename) return
    setBusy('rename')
    try {
      const res = await api.scan.rename(filePath, renameTrimmed, codeTrimmed, selectedTarget())
      if (res.imported) {
        toast.show(`已重命名并导入：${res.code}`, 'success')
        onResolved(filePath)
      } else {
        toast.show(`已重命名，但未能导入番号 ${res.code}`, 'info')
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setBusy(null)
    }
  }

  const copyPath = async (): Promise<void> => {
    await navigator.clipboard.writeText(filePath)
    toast.show('路径已复制', 'success')
  }

  const revealFile = async (): Promise<void> => {
    const result = await api.scan.revealAuditFile(filePath)
    if (!result.ok) {
      toast.show(result.fileMissing ? '文件已不存在' : result.error || '无法打开目录', 'error')
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <div className={styles.titleWrap}>
          <span className={styles.badge}>
            <AlertCircle size={13} aria-hidden />
            无法识别番号
          </span>
          <strong className={styles.name} title={fullName}>
            {fullName}
          </strong>
        </div>
        <div className={styles.quickActions}>
          <IconButton
            size="sm"
            className={styles.iconButton}
            icon={<Copy {...UI_ICON_SM} />}
            label="复制完整路径"
            onClick={() => void copyPath()}
          />
          <IconButton
            size="sm"
            className={styles.iconButton}
            icon={<FolderOpen {...UI_ICON_SM} />}
            label="在文件夹中显示"
            onClick={() => void revealFile()}
          />
        </div>
      </div>

      <div className={styles.path} title={filePath}>
        {filePath}
      </div>

      <div className={styles.actions}>
        <div className={styles.edit}>
          <input
            className={`text-input ${styles.codeInput}`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doManualImport()
            }}
            placeholder="输入番号（如 ABC-123）"
            aria-label={`${fullName} 番号`}
          />
          <SelectControl
            className={styles.targetSelect}
            value={targetValue}
            onChange={(event) => setTargetValue(event.target.value)}
            disabled={busy !== null || loadingTargets || !codeTrimmed}
            aria-label={`${fullName} 导入目标`}
          >
            <option value="">{loadingTargets ? '查找中…' : '选择目标'}</option>
            {matchingVideos.map((video) => (
              <option key={video.id} value={`existing:${video.id}`}>
                ID {video.id} · {video.code}
                {video.title ? ` · ${video.title}` : ''}
              </option>
            ))}
            <option value="new">新建独立影片</option>
          </SelectControl>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy !== null || !canImport}
            onClick={() => void doManualImport()}
          >
            {busy === 'import' ? '处理中…' : '导入'}
          </Button>
        </div>

        <details className={styles.rename}>
          <summary>重命名源文件（可选）</summary>
          <div className={`${styles.edit} ${styles.renameEdit}`}>
            <input
              className={`text-input ${styles.renameInput}`}
              value={renameBase}
              onChange={(e) => setRenameBase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doRename()
              }}
              placeholder="新文件名（需先选择上方导入目标）"
              aria-label={`${fullName} 新文件名`}
            />
            {ext && <span className={styles.extension}>{ext}</span>}
            <Button
              type="button"
              size="sm"
              disabled={busy !== null || !canRename}
              onClick={() => void doRename()}
            >
              {busy === 'rename' ? '处理中…' : '重命名并导入'}
            </Button>
          </div>
        </details>
      </div>
    </div>
  )
}
