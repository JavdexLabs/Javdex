import type {
  VideoLifecycleImpact,
  VideoLifecycleMediaAssetImpact,
  VideoLifecycleResourceImpact
} from '@shared/videoLifecycleTypes'
import styles from './VideoDeleteImpact.module.css'

const RESOURCE_KIND_LABELS: Record<VideoLifecycleResourceImpact['kind'], string> = {
  local: '本地视频',
  direct: '视频直链',
  web: '网页',
  magnet: 'Magnet',
  ed2k: 'ED2K'
}

function assetLabel(asset: VideoLifecycleMediaAssetImpact): string {
  if (asset.type === 'cover') return '封面'
  if (asset.type === 'poster') return '海报'
  if (asset.type === 'sample') return '样张'
  return asset.type
}

export default function VideoDeleteImpact({
  impact
}: {
  impact: VideoLifecycleImpact
}): JSX.Element {
  return (
    <div className={`${styles.root} selectable-text`}>
      <p className={styles.lead}>
        将永久删除全局影片资料，以及下列媒体库成员、资源记录和关联数据。此操作不可恢复。
      </p>

      <dl className={styles.metrics} aria-label="删除影响汇总">
        <div className={styles.metricItem}>
          <dt className={styles.metricTerm}>媒体库</dt>
          <dd className={styles.metricValue}>{impact.libraries.length}</dd>
        </div>
        <div className={styles.metricItem}>
          <dt className={styles.metricTerm}>资源记录</dt>
          <dd className={styles.metricValue}>{impact.resources.length}</dd>
        </div>
        <div className={styles.metricItem}>
          <dt className={styles.metricTerm}>清单</dt>
          <dd className={styles.metricValue}>{impact.playlists.length}</dd>
        </div>
        <div className={styles.metricItem}>
          <dt className={styles.metricTerm}>应用图片</dt>
          <dd className={styles.metricValue}>{impact.mediaAssets.length}</dd>
        </div>
      </dl>

      <section className={styles.section} aria-labelledby="delete-impact-libraries">
        <h4 id="delete-impact-libraries" className={styles.sectionTitle}>媒体库与资源</h4>
        {impact.libraries.length > 0 ? (
          <ul className={styles.list}>
            {impact.libraries.map((library) => (
              <li key={library.libraryId} className={styles.row}>
                <span className={styles.primary}>{library.name}</span>
                <span className={styles.meta}>
                  {library.status === 'archived' ? '已归档 · ' : ''}
                  {library.resourceCount} 个资源
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>不属于任何媒体库</p>
        )}
        {impact.resources.length > 0 ? (
          <ul className={`${styles.list} ${styles.resourceList}`}>
            {impact.resources.map((resource) => (
              <li key={resource.resourceId} className={styles.resourceRow}>
                <span className={styles.resourceHead}>
                  <span className={styles.primary}>
                    {RESOURCE_KIND_LABELS[resource.kind]}
                    {resource.isPrimary ? ' · 主资源' : ''}
                  </span>
                  <span className={styles.meta}>媒体库 #{resource.libraryId}</span>
                </span>
                <span className={styles.path} title={resource.displayLocator}>
                  {resource.displayName || resource.displayLocator}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby="delete-impact-relations">
        <h4 id="delete-impact-relations" className={styles.sectionTitle}>清单关联</h4>
        {impact.playlists.length > 0 ? (
          <ul className={styles.list}>
            {impact.playlists.map((playlist) => (
              <li key={playlist.playlistId} className={styles.row}>
                <span className={styles.primary}>{playlist.name}</span>
                <span className={styles.meta}>将从清单移除</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>没有清单关联</p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="delete-impact-assets">
        <h4 id="delete-impact-assets" className={styles.sectionTitle}>
          应用管理的图片与暂存资源
        </h4>
        {impact.mediaAssets.length > 0 ? (
          <ul className={styles.list}>
            {impact.mediaAssets.map((asset, index) => (
              <li key={`${asset.assetId ?? 'video'}-${asset.type}-${index}`} className={styles.row}>
                <span className={styles.primary}>{assetLabel(asset)}</span>
                <span className={`${styles.path} ${styles.rowPath}`}>
                  {asset.localPath ?? '仅远程引用'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>没有应用管理的影片图片</p>
        )}
        <p className={styles.pending}>
          待确认刮削 {impact.pendingScrapeCount} 项，Agent 草稿 {impact.pendingAgentDraftCount} 项，
          暂存图片 {impact.pendingStagingAssetCount} 个；相关暂存文件会一并清理。
        </p>
      </section>

      <section className={styles.safe} aria-labelledby="delete-impact-source-files">
        <h4 id="delete-impact-source-files" className={`${styles.sectionTitle} ${styles.safeTitle}`}>
          磁盘源文件会保留
        </h4>
        <p className={styles.safeText}>本地视频与 STRM 源文件不会删除，只移除 Javdex 中的资源记录。</p>
        {impact.sourcePaths.length > 0 ? (
          <ul className={styles.sourcePaths}>
            {impact.sourcePaths.map((sourcePath) => (
              <li key={sourcePath} className={styles.sourcePath} title={sourcePath}>
                {sourcePath}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  )
}
