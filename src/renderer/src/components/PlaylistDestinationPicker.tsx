import { useState } from 'react'
import { useDebounce } from '../hooks/useDebounce'
import { usePlaylistBrowsePage } from '../hooks/usePlaylistBrowsePage'
import SelectControl from './SelectControl'
import Button from './Button'
import PlaylistBrowsePager from './PlaylistBrowsePager'

/** Import destination holds one selected identity even while browsing another page. */
export default function PlaylistDestinationPicker({value,label,onChange,disabled=false}: {
  value:string;label?:string;onChange:(id:string,label:string)=>void;disabled?:boolean
}): JSX.Element {
  const [input,setInput]=useState(''),[offset,setOffset]=useState(0)
  const search=useDebounce(input.trim(),250),ready=search===input.trim()
  const page=usePlaylistBrowsePage({search,offset,limit:60},ready)
  const items=page.data?.items ?? []
  return <div>
    <input className="text-input" aria-label="搜索目标清单" placeholder="搜索目标清单" maxLength={500} value={input} disabled={disabled}
      onChange={event=>{setInput(event.target.value);setOffset(0)}}/>
    <SelectControl value={value} disabled={disabled || !ready || page.loading || Boolean(page.error)} onChange={event=>{
      const item=items.find(item=>String(item.id)===event.target.value)
      if(item)onChange(String(item.id),item.name)
    }}>
      <option value="" disabled>请选择清单</option>
      {value && !items.some(item=>String(item.id)===value) && <option value={value}>{Array.from(label || `清单 #${value}`).slice(0,129).join('')}</option>}
      {items.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
    </SelectControl>
    {(!ready || page.loading) && <span role="status">读取中…</span>}
    {page.error && <div role="alert">{page.error}<Button onClick={()=>void page.reload()}>重试</Button></div>}
    <PlaylistBrowsePager offset={page.data?.offset ?? offset} limit={60} total={page.data?.total ?? 0} disabled={disabled || !ready || page.loading || Boolean(page.error)} onPage={setOffset}/>
  </div>
}
