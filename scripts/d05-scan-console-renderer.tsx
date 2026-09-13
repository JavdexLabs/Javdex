import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import MediaLibraryScanRunButton from '../apps/desktop/src/renderer/src/components/settings/MediaLibraryScanRunButton'
import { useMediaLibraryScanController } from '../apps/desktop/src/renderer/src/hooks/useMediaLibraryScanController'

const library = {
  status: 'active' as const,
  activeRootCount: 1,
  pendingCleanupJobCount: 0
}

function ScanConsole(): JSX.Element {
  const scan = useMediaLibraryScanController(1, { loadLatest: true })
  return (
    <section aria-label="扫描导入">
      <h4>扫描导入</h4>
      <p>导入新影片、同步路径变动并清理失效记录。</p>
      <MediaLibraryScanRunButton scan={scan} library={library} formDisabled={false} />
    </section>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ScanConsole />
  </QueryClientProvider>
)
