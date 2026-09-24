import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { BatchScrapeProvider } from '../contexts/BatchScrapeContext'
import { DesktopSessionProvider } from '../desktop/DesktopSessionContext'
import LibraryDataSync from './LibraryDataSync'
import { queryClient } from './queryClient'

export default function QueryProvider({ children }: { children: ReactNode }): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <DesktopSessionProvider>
        <BatchScrapeProvider>
          <LibraryDataSync />
          {children}
        </BatchScrapeProvider>
      </DesktopSessionProvider>
    </QueryClientProvider>
  )
}
