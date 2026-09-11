import Button from './Button'
export default function PlaylistBrowsePager({ offset,limit,total,disabled,onPage }: {
  offset:number;limit:number;total:number;disabled?:boolean;onPage:(offset:number)=>void
}): JSX.Element {
  return <div className="actress-works-pagination" aria-label="清单分页">
    <Button size="sm" disabled={disabled || offset===0} onClick={()=>onPage(Math.max(0,offset-limit))}>上一页</Button>
    <span aria-live="polite">{total ? offset+1 : 0}–{Math.min(offset+limit,total)} / {total}</span>
    <Button size="sm" disabled={disabled || offset+limit>=total} onClick={()=>onPage(offset+limit)}>下一页</Button>
  </div>
}
