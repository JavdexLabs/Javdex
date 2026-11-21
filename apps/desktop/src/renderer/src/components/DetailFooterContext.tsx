import { createContext, useContext } from 'react'

export const DetailFooterContext = createContext<HTMLDivElement | null>(null)

export function useDetailFooterHost(): HTMLDivElement | null {
  return useContext(DetailFooterContext)
}
