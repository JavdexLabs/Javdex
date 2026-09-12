import { useEffect, useState, type SetStateAction } from 'react'

function equal<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Keep in-progress edits when another settings group refreshes the saved snapshot. */
export function useSettingsDraft<T>(saved: T) {
  const [state, setState] = useState({ baseline: saved, draft: saved, conflict: false })
  useEffect(() => {
    setState((current) => {
      if (equal(current.baseline, saved)) return current
      if (equal(current.draft, current.baseline) || equal(current.draft, saved)) {
        return { baseline: saved, draft: saved, conflict: false }
      }
      if (
        saved &&
        current.baseline &&
        current.draft &&
        typeof saved === 'object' &&
        !Array.isArray(saved)
      ) {
        const draft = { ...current.draft }
        let conflict = current.conflict
        for (const key of Object.keys(saved) as (keyof T)[]) {
          if (equal(current.draft[key], current.baseline[key])) draft[key] = saved[key]
          else if (
            !equal(saved[key], current.baseline[key]) &&
            !equal(saved[key], current.draft[key])
          )
            conflict = true
        }
        return { baseline: saved, draft, conflict }
      }
      return { ...current, baseline: saved, conflict: true }
    })
  }, [saved])
  return {
    draft: state.draft,
    dirty: !equal(state.draft, state.baseline),
    conflict: state.conflict,
    setDraft: (next: SetStateAction<T>): void =>
      setState((current) => ({
        ...current,
        draft: typeof next === 'function' ? (next as (value: T) => T)(current.draft) : next
      })),
    reset: (): void => setState({ baseline: saved, draft: saved, conflict: false }),
    accept: (next: T, submitted: T = next): void =>
      setState((current) => ({
        baseline: next,
        draft: equal(current.draft, submitted) ? next : current.draft,
        conflict: false
      }))
  }
}
