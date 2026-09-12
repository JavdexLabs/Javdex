import { useCallback, useMemo, useRef } from 'react'
import { highlightJavaScript } from '../utils/highlightJavaScript'
import styles from './CodeEditor.module.css'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  'aria-label'?: string
}

export default function CodeEditor({
  value,
  onChange,
  className = '',
  placeholder,
  disabled = false,
  'aria-label': ariaLabel
}: CodeEditorProps): JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlighted = useMemo(() => highlightJavaScript(value), [value])

  const syncScroll = useCallback((): void => {
    const pre = preRef.current
    const textarea = textareaRef.current
    if (!pre || !textarea) return
    pre.scrollTop = textarea.scrollTop
    pre.scrollLeft = textarea.scrollLeft
  }, [])

  return (
    <div
      className={`${styles.root}${disabled ? ` ${styles.disabled}` : ''} code-editor${className ? ` ${className}` : ''}`}
      data-disabled={disabled || undefined}
    >
      <pre ref={preRef} className={styles.highlight} aria-hidden="true">
        <code>
          {value ? (
            <span dangerouslySetInnerHTML={{ __html: highlighted }} />
          ) : (
            <span className={styles.placeholder}>{placeholder}</span>
          )}
        </code>
      </pre>
      <textarea
        ref={textareaRef}
        className={styles.input}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        disabled={disabled}
        aria-label={ariaLabel ?? '代码编辑器'}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
      />
    </div>
  )
}
