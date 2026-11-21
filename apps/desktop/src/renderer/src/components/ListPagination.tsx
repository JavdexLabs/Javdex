import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { LIST_PAGE_SIZES, normalizeListPageSize, type ListPageSize } from '@shared/settingsTypes'
import { UI_ICON_SM } from './iconDefaults'
import SelectControl from './SelectControl'
import styles from './ListPagination.module.css'

export function buildPaginationItems(
  page: number,
  totalPages: number
): ReadonlyArray<number | 'ellipsis-start' | 'ellipsis-end'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1)
  }
  const safePage = Math.min(Math.max(1, page), totalPages)
  if (safePage <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis-end', totalPages]
  }
  if (safePage >= totalPages - 3) {
    return [
      1,
      'ellipsis-start',
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages
    ]
  }
  return [1, 'ellipsis-start', safePage - 1, safePage, safePage + 1, 'ellipsis-end', totalPages]
}

export interface ListPaginationProps {
  label?: string
  page: number
  pageSize: ListPageSize
  total: number
  inline?: boolean
  onPageChange: (nextPage: number) => void
  onPageSizeChange?: (nextSize: ListPageSize) => void
}

export default function ListPagination({
  label = '列表分页',
  page,
  pageSize,
  total,
  inline = false,
  onPageChange,
  onPageSizeChange
}: ListPaginationProps): JSX.Element | null {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const [jumpDraft, setJumpDraft] = useState(String(safePage))

  useEffect(() => {
    setJumpDraft(String(safePage))
  }, [safePage])

  if (total <= 0) return null

  const rangeStart = (safePage - 1) * pageSize + 1
  const rangeEnd = Math.min(total, safePage * pageSize)
  const items = buildPaginationItems(safePage, totalPages)
  const pageDigits = totalPages >= 1000 ? '4' : totalPages >= 100 ? '3' : '2'

  const commitJump = (): void => {
    const trimmed = jumpDraft.trim()
    if (!/^\d+$/.test(trimmed)) {
      setJumpDraft(String(safePage))
      return
    }
    const target = Math.min(totalPages, Math.max(1, Number(trimmed)))
    setJumpDraft(String(target))
    if (target !== safePage) onPageChange(target)
  }

  return (
    <nav
      className={styles.root}
      data-inline={inline || undefined}
      data-list-pagination
      aria-label={label}
    >
      <span className={styles.summary}>
        第 {rangeStart}–{rangeEnd} 项 · 共 {total} 项
      </span>

      <div className={styles.center}>
        <div className={styles.pagerTrack} data-digits={pageDigits}>
          <button
            type="button"
            className={styles.stepButton}
            aria-label="上一页"
            title="上一页"
            disabled={safePage <= 1}
            onClick={() => onPageChange(safePage - 1)}
          >
            <ChevronLeft {...UI_ICON_SM} aria-hidden="true" />
          </button>

          <div className={styles.pages} role="group" aria-label="页码">
            {items.map((item) =>
              typeof item === 'number' ? (
                <button
                  key={item}
                  type="button"
                  className={styles.pageButton}
                  aria-current={item === safePage ? 'page' : undefined}
                  aria-label={`第 ${item} 页`}
                  onClick={() => {
                    if (item !== safePage) onPageChange(item)
                  }}
                >
                  {item}
                </button>
              ) : (
                <span key={item} className={styles.ellipsis} aria-hidden="true">
                  …
                </span>
              )
            )}
          </div>

          <button
            type="button"
            className={styles.stepButton}
            aria-label="下一页"
            title="下一页"
            disabled={safePage >= totalPages}
            onClick={() => onPageChange(safePage + 1)}
          >
            <ChevronRight {...UI_ICON_SM} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className={styles.trailing}>
        {totalPages > 1 ? (
          <form
            className={styles.jumpForm}
            onSubmit={(event) => {
              event.preventDefault()
              commitJump()
            }}
          >
            <input
              type="text"
              inputMode="numeric"
              className={styles.jumpInput}
              aria-label="跳转页码"
              title="输入页码后按回车跳转"
              value={jumpDraft}
              onChange={(event) => setJumpDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={commitJump}
            />
            <span className={styles.jumpTotal}>/ {totalPages} 页</span>
          </form>
        ) : null}

        {totalPages > 1 && onPageSizeChange ? (
          <span className={styles.divider} aria-hidden="true" />
        ) : null}

        <div className={styles.sizeGroup}>
          {onPageSizeChange ? (
            <SelectControl
              className={styles.sizeSelect}
              buttonClassName={styles.sizeSelectButton}
              aria-label="每页显示数量"
              title="每页显示数量"
              value={pageSize}
              onChange={(event) => {
                const next = normalizeListPageSize(event.target.value)
                if (next !== pageSize) onPageSizeChange(next)
              }}
            >
              {LIST_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} 条/页
                </option>
              ))}
            </SelectControl>
          ) : (
            <span className={styles.sizeLabel}>{pageSize} 条/页</span>
          )}
        </div>
      </div>
    </nav>
  )
}
