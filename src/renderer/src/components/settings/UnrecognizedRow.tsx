import { useState } from 'react'
import type { ManualImportResult } from '@shared/types'
import { api } from '../../api'
import { useToast } from '../Toast'

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

  const codeTrimmed = code.trim()
  const renameTrimmed = renameBase.trim()
  const canImport = codeTrimmed.length > 0
  const canRename = renameTrimmed.length > 0 && renameTrimmed !== baseName

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

  const doManualImport = async (): Promise<void> => {
    if (busy || !canImport) return
    setBusy('import')
    try {
      finishImport(await api.scan.importManual(filePath, codeTrimmed))
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
      const res = await api.scan.rename(filePath, renameTrimmed)
      if (res.imported) {
        toast.show(`已重命名并导入：${res.code}`, 'success')
        onResolved(filePath)
      } else if (res.code) {
        toast.show(`已重命名（番号 ${res.code} 已存在，未重复导入）`, 'info')
        onResolved(filePath)
      } else {
        toast.show('已重命名；若需导入请使用「导入」并手工填写番号', 'info')
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
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy !== null || !canImport}
          onClick={() => void doManualImport()}
        >
          {busy === 'import' ? '处理中…' : '导入'}
        </button>
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
            placeholder="新文件名"
            aria-label={`${fullName} 新文件名`}
          />
          {ext && <span className="scan-unrec-ext">{ext}</span>}
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null || !canRename}
            onClick={() => void doRename()}
          >
            {busy === 'rename' ? '处理中…' : '重命名'}
          </button>
        </div>
      </details>
      </div>
    </div>
  )
}
