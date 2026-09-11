import Button from './Button'
export default function RelatedVideoPager({ offset, total, fetching, move, error, retry }: {
  offset: number; total: number; fetching: boolean; move(offset: number): void; error: unknown; retry(): void
}): JSX.Element {
  return <div className="entity-browsing-pager" aria-label="关联影片分页">
    <Button size="sm" disabled={fetching || offset === 0} onClick={() => move(Math.max(0, offset - 60))}>上一页</Button>
    <span aria-live="polite">{total ? offset + 1 : 0}–{Math.min(offset + 60, total)} / {total}</span>
    <Button size="sm" disabled={fetching || offset + 60 >= total} onClick={() => move(offset + 60)}>下一页</Button>
    {Boolean(error) && <Button size="sm" onClick={retry}>加载失败，重试</Button>}
  </div>
}
