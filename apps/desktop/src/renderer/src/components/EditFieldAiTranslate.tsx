import { useState } from 'react'
import { api } from '../api'
import { useToast } from './Toast'
import styles from './EditFieldAiTranslate.module.css'

export default function EditFieldAiTranslate({
  text,
  disabled = false,
  onTranslated
}: {
  text: string
  disabled?: boolean
  onTranslated: (translated: string) => void
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const handleClick = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) {
      toast.show('没有可翻译的内容', 'info')
      return
    }
    setBusy(true)
    try {
      const translated = await api.llm.translateToChinese(trimmed)
      onTranslated(translated)
      toast.show('已翻译为中文', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={styles.root}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={() => void handleClick()}
    >
      <span className={styles.reserve} aria-hidden="true">翻译中…</span>
      <span className={styles.label}>{busy ? '翻译中…' : 'AI 译中'}</span>
    </button>
  )
}
