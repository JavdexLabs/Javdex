import { useMemo } from 'react'
import Modal from '../Modal'
import { highlightJavaScript } from '../../utils/highlightJavaScript'
import { getPluginDevKindProfile } from '@shared/pluginDevKindProfile'
import type { PluginKind } from './types'
import styles from './PluginDevCodeModal.module.css'
import { codeHighlightClasses } from '../CodeHighlight'

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
  const highlighted = useMemo(() => highlightJavaScript(code, codeHighlightClasses), [code])
  const placeholder = useMemo(() => getPluginDevKindProfile(kind).buildCodeModalPlaceholder(), [kind])

  return (
    <Modal
      title={`插件代码 · ${pluginName || '未命名'}`}
      className={styles.modal}
      bodyClassName={styles.body}
      chrome="shellless"
      hideCancel
      confirmText="关闭"
      onConfirm={onClose}
      onCancel={onClose}
    >
      <div className={styles.shell}>
        <pre className={styles.viewer} aria-label="插件代码">
          <code>
            {code ? (
              <span dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <span className={styles.placeholder}>{placeholder}</span>
            )}
          </code>
        </pre>
      </div>
    </Modal>
  )
}
