import { useMemo } from 'react'
import Modal from '../Modal'
import { highlightJavaScript } from '../../utils/highlightJavaScript'
import { getPluginDevKindProfile } from '@shared/pluginDevKindProfile'
import type { PluginKind } from './types'

export default function PluginDevCodeModal({
  kind,
  code,
  pluginName,
  onClose
}: {
  kind: PluginKind
  code: string
  pluginName: string
  onClose: () => void
}): JSX.Element {
  const highlighted = useMemo(() => highlightJavaScript(code), [code])
  const placeholder = useMemo(() => getPluginDevKindProfile(kind).buildCodeModalPlaceholder(), [kind])

  return (
    <Modal
      title={`插件代码 · ${pluginName || '未命名'}`}
      className="modal--plugin-dev-code"
      hideCancel
      confirmText="关闭"
      onConfirm={onClose}
      onCancel={onClose}
    >
      <div className="plugin-dev-code-modal-shell">
        <pre className="plugin-dev-code-viewer" aria-label="插件代码">
          <code>
            {code ? (
              <span dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <span className="code-editor-placeholder">{placeholder}</span>
            )}
          </code>
        </pre>
      </div>
    </Modal>
  )
}
