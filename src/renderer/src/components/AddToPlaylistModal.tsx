import { useMemo } from 'react'
import PlaylistVideoPicker from './PlaylistVideoPicker'
interface Props { videoId:number;videoCode:string;onCancel:()=>void;onChanged?:()=>void }
export default function AddToPlaylistModal({videoId,videoCode,...rest}: Props): JSX.Element {
  const videoIds=useMemo(()=>[videoId],[videoId])
  return <PlaylistVideoPicker key={videoId} {...rest} videoIds={videoIds} subtitle={videoCode} single/>
}
