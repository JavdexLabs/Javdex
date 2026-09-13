import { Play, Square } from 'lucide-react'
import type { MediaLibrarySummary } from '@shared/mediaLibraryTypes'
import Button from '../Button'
import { UI_ICON_SM } from '../iconDefaults'
import type { MediaLibraryScanController } from '../../hooks/useMediaLibraryScanController'
import { canRunMediaLibraryScan } from '../../mediaLibrarySettingsState'

export default function MediaLibraryScanRunButton({
  scan,
  library,
  formDisabled
}: {
  scan: Pick<MediaLibraryScanController, 'running' | 'cancelling' | 'activeRunId' | 'start' | 'cancel'>
  library: Pick<MediaLibrarySummary, 'status' | 'activeRootCount' | 'pendingCleanupJobCount'>
  formDisabled: boolean
}): JSX.Element {
  return (
    <Button
      type="button"
      variant={scan.running ? 'default' : 'primary'}
      disabled={
        scan.running
          ? scan.cancelling || !scan.activeRunId
          : formDisabled || !canRunMediaLibraryScan(library)
      }
      title={
        !scan.running && !canRunMediaLibraryScan(library)
          ? '请先添加或启用来源目录'
          : undefined
      }
      onClick={() => void (scan.running ? scan.cancel() : scan.start())}
    >
      {scan.running ? (
        <Square {...UI_ICON_SM} aria-hidden />
      ) : (
        <Play {...UI_ICON_SM} aria-hidden />
      )}
      {scan.running
        ? scan.cancelling
          ? '正在取消…'
          : '取消扫描'
        : library.activeRootCount > 0
          ? '扫描并导入'
          : '执行待清理'}
    </Button>
  )
}
