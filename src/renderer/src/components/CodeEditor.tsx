import { useCallback, useMemo, useRef } from 'react'
import { highlightJavaScript } from '../utils/highlightJavaScript'

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
    <div className={`code-editor${className ? ` ${className}` : ''}${disabled ? ' is-disabled' : ''}`}>
      <pre ref={preRef} className="code-editor-highlight" aria-hidden="true">
        <code>
          {value ? (
            <span dangerouslySetInnerHTML={{ __html: highlighted }} />
          ) : (
            <span className="code-editor-placeholder">{placeholder}</span>
          )}
        </code>
      </pre>
      <textarea
        ref={textareaRef}
        className="code-editor-input"
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
