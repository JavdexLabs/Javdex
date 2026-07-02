import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryClient } from './queryClient'

export default function QueryProvider({ children }: { children: ReactNode }): JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
