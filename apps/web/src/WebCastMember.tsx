import { useState } from 'react'
import { UserRound } from 'lucide-react'
import type { WebDetail } from '../../../packages/contracts/src/webTypes'
import { imageThumbnailUrl } from '../../../packages/contracts/src/imageVariants'
import { route } from './navigation'
import styles from './WebCastMember.module.css'

export default function WebCastMember({ actress }: { actress: WebDetail['actresses'][number] }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const next = new URLSearchParams({ actress: String(actress.id), label: actress.name })
  return <a className={styles.root} data-web-cast-member href={route('/browse', next)}>
    <span className={styles.avatar} aria-hidden="true">
      {actress.avatar && !failed ? <img src={imageThumbnailUrl(actress.avatar, 320)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <UserRound />}
    </span>
    <span className={styles.name}>{actress.name}</span>
    <span className={styles.gender}>{actress.gender === 'female' ? '♀ 女' : actress.gender === 'male' ? '♂ 男' : '性别未知'}</span>
  </a>
}
