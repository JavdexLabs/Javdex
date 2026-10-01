import { ChevronLeft, ChevronRight } from 'lucide-react'
import { WebButton } from './WebButton'
import styles from './WebPagination.module.css'

export default function WebPagination({ page, total, pageSize, onPageChange }: {
  page: number
  total: number
  pageSize: number
  onPageChange: (page: number) => void
}): JSX.Element {
  return <nav className={styles.root} data-web-pagination data-navigation-group aria-label="结果分页">
    <WebButton disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
      <ChevronLeft aria-hidden="true" />上一页
    </WebButton>
    <span>{page} /{' '}{Math.max(1, Math.ceil(total / pageSize))}</span>
    <WebButton disabled={page * pageSize >= total} onClick={() => onPageChange(page + 1)}>
      下一页<ChevronRight aria-hidden="true" />
    </WebButton>
  </nav>
}
