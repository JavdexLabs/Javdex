import { useEffect, useState } from 'react'
import type { ManualImportResult } from '@shared/libraryTypes'
import type { Video, VideoResourceImportTarget } from '@shared/videoTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import { api } from '../../api'
import { normalizeOptionalVideoCode } from '../videoResourceImportForm'
import { useToast } from '../Toast'
import Button from '../Button'
import SelectControl from '../SelectControl'

/** One editable row in the "unrecognized files" list: manual import or rename on disk. */
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
      void api.videos.list({ search: normalized, limit: 100, offset: 0 })
        .then((result) => {
          if (!cancelled) {
            setMatchingVideos(result.items.filter((video) => normalizeVideoCode(video.code) === normalized))
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
      const res = await api.scan.rename(
        filePath,
        renameTrimmed,
        codeTrimmed,
        selectedTarget()
      )
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

  return (
    <div className="scan-unrec-row">
      <div className="scan-unrec-head">
        <strong className="scan-unrec-name" title={filePath}>
          {fullName}
        </strong>
        <span className="scan-unrec-dir" title={filePath}>
          {filePath}
        </span>
      </div>
      <div className="scan-unrec-actions">
        <div className="scan-unrec-edit">
        <input
          className="text-input scan-unrec-code-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doManualImport()
          }}
          placeholder="输入番号"
          aria-label={`${fullName} 番号`}
        />
        <SelectControl
          className="scan-unrec-target-select"
          value={targetValue}
          onChange={(event) => setTargetValue(event.target.value)}
          disabled={busy !== null || loadingTargets || !codeTrimmed}
          aria-label={`${fullName} 导入目标`}
        >
          <option value="">{loadingTargets ? '查找中…' : '选择目标'}</option>
          {matchingVideos.map((video) => (
            <option key={video.id} value={`existing:${video.id}`}>
              ID {video.id} · {video.code}{video.title ? ` · ${video.title}` : ''}
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
        <details className="scan-unrec-rename">
        <summary>重命名文件（可选）</summary>
        <div className="scan-unrec-edit scan-unrec-edit--rename">
          <input
            className="text-input scan-unrec-rename-input"
            value={renameBase}
            onChange={(e) => setRenameBase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRename()
            }}
            placeholder="新文件名（需先选择上方导入目标）"
            aria-label={`${fullName} 新文件名`}
          />
          {ext && <span className="scan-unrec-ext">{ext}</span>}
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
