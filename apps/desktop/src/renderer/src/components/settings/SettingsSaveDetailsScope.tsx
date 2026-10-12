import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import styles from './SettingsFormActions.module.css'

export const SettingsSaveDetailsContext = createContext<{
  host: HTMLDivElement | null
  setHost: (host: HTMLDivElement | null) => void
} | null>(null)

/** Keeps header save feedback in its own card, without an overlay. */
export function SettingsSaveDetailsScope({ children }: { children: ReactNode }): JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const value = useMemo(() => ({ host, setHost }), [host])
  return <SettingsSaveDetailsContext.Provider value={value}>
    {children}
  </SettingsSaveDetailsContext.Provider>
}

/** Place directly after the header containing the save controls. */
export function SettingsSaveDetailsSlot(): JSX.Element {
  const context = useContext(SettingsSaveDetailsContext)
  return <div ref={context?.setHost} className={styles.detailSlot} />
}
