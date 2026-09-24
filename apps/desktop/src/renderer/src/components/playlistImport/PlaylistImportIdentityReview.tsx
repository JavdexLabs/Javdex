import { ExternalLink } from 'lucide-react'
import type { PlaylistImportIdentityReviewItem } from '@shared/playlistImportTypes'
import styles from './PlaylistImportIdentityReview.module.css'

export type PlaylistImportIdentityChoice =
  | { kind: 'existing'; videoId: number }
  | { kind: 'create' }

function isCandidateSelected(
  choice: PlaylistImportIdentityChoice | undefined,
  videoId: number
): boolean {
  return choice?.kind === 'existing' && choice.videoId === videoId
}

export default function PlaylistImportIdentityReview({
  items,
  choices,
  onChange,
  onOpenExternalLink
}: {
  items: PlaylistImportIdentityReviewItem[]
  choices: Record<number, PlaylistImportIdentityChoice>
  onChange: (itemId: number, choice: PlaylistImportIdentityChoice) => void
  onOpenExternalLink: (url: string) => void
}): JSX.Element {
  return (
    <section className={styles.identityReview} aria-label="身份确认">
      <header className={styles.sectionHeader}>
        <strong className={styles.sectionTitle}>需要确认身份</strong>
        <span className={styles.sectionMeta}>{items.length} 部</span>
      </header>
      {items.map((item) => (
        <div key={item.itemId} className={styles.identityRow}>
          <div className={styles.identityCopy}>
            <strong className={styles.identityTitle}>
              {item.code || item.title || `外部条目 #${item.itemId}`}
            </strong>
            <button
              className={styles.detailLink}
              type="button"
              onClick={() => onOpenExternalLink(item.detailUrl)}
              title={item.detailUrl}
            >
              {item.detailUrl}<ExternalLink size={11} aria-hidden />
            </button>
            {item.conflict?.kind === 'code-mismatch' ? (
              <p className={styles.identityConflict} role="alert">
                清单番号 {item.conflict.listCode} 与详情页番号 {item.conflict.detailCode} 不一致，
                请核对候选后选择已有影片或创建新影片。
              </p>
            ) : item.conflict?.kind === 'sensitive-detail-url' ? (
              <p className={styles.identityConflict} role="alert">
                原详情链接包含访问令牌、签名或凭据，敏感参数已移除且不会保存。
                请根据安全链接和候选确认复用已有影片或创建新影片。
              </p>
            ) : null}
          </div>
          <div
            className={styles.identityCandidates}
            role="radiogroup"
            aria-label={`选择 ${item.code || item.title || item.itemId} 的身份`}
          >
            {item.candidates.map((candidate) => (
              <div
                key={candidate.videoId}
                className={styles.candidateCard}
                data-selected={isCandidateSelected(choices[item.itemId], candidate.videoId)}
              >
                <button
                  type="button"
                  className={styles.candidateChoice}
                  role="radio"
                  aria-checked={isCandidateSelected(choices[item.itemId], candidate.videoId)}
                  onClick={() => onChange(item.itemId, {
                    kind: 'existing',
                    videoId: candidate.videoId
                  })}
                >
                  <span className={styles.candidateHeading}>
                    <strong>{candidate.code}</strong>
                    <span>{candidate.title || `影片 #${candidate.videoId}`}</span>
                  </span>
                  <span className={styles.candidateFacts}>
                    {candidate.publisher ? <span>发行商：{candidate.publisher}</span> : null}
                    {candidate.releaseDate ? <span>发行：{candidate.releaseDate}</span> : null}
                    <span>
                      媒体库：{candidate.libraryNames.length
                        ? candidate.libraryNames.join('、')
                        : '未归属'}
                    </span>
                    <span>
                      资源：{candidate.resourceKinds.length
                        ? candidate.resourceKinds.join('、')
                        : '无资源'}
                    </span>
                  </span>
                </button>
                {candidate.relatedLinks.length > 0 ? (
                  <div className={styles.candidateLinks}>
                    {candidate.relatedLinks.map((link) => (
                      <button
                        key={link.url}
                        type="button"
                        onClick={() => onOpenExternalLink(link.url)}
                        title={link.url}
                      >
                        {link.label}<ExternalLink size={10} aria-hidden />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              className={styles.createCandidate}
              role="radio"
              aria-checked={choices[item.itemId]?.kind === 'create'}
              data-selected={choices[item.itemId]?.kind === 'create'}
              onClick={() => onChange(item.itemId, { kind: 'create' })}
            >
              <strong>创建新的无资源影片</strong>
              <span>不复用以上候选，在目标媒体库建立新影片。</span>
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}
