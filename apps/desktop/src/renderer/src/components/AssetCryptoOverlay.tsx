import { useEffect, useState } from 'react'
import type { AssetCryptoProgress } from '@shared/libraryTypes'
import { api } from '../api'
import styles from './AssetCryptoOverlay.module.css'

/** Full-screen blocker while the main process migrates all cover/avatar files. */
export default function AssetCryptoOverlay(): JSX.Element | null {
  const [progress, setProgress] = useState<AssetCryptoProgress | null>(null)

  useEffect(() => {
    return api.assetCrypto.onProgress((p) => {
      if (p.status === 'done') {
        setProgress(null)
        return
      }
      setProgress(p)
    })
  }, [])

  if (!progress || progress.status !== 'running') return null

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0
  const title =
    progress.phase === 'encrypt'
      ? '正在加密图片'
      : progress.phase === 'decrypt'
        ? '正在解密图片'
        : '正在迁移媒体资源'

  return (
    <div className={styles.root} role="alertdialog" aria-modal="true">
      <div className={styles.panel}>
        <h3>{title}</h3>
        <p className={styles.hint}>
          {progress.phase === 'relocate'
            ? '媒体资源文件迁移中，请勿关闭应用或进行其他操作。'
            : '全库封面与头像迁移中，请勿关闭应用或进行其他操作。'}
        </p>
        <div className={styles.track}>
          <div className={styles.fill} style={{ width: `${pct}%` }} />
        </div>
        <div className={styles.stats}>
          <span>
            进度 {progress.current}/{progress.total}
          </span>
          {progress.currentFile && <span>{progress.currentFile}</span>}
        </div>
      </div>
    </div>
  )
}
