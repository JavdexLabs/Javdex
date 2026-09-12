import PlaylistVideoPicker from './PlaylistVideoPicker'
interface Props { videoIds:number[];onCancel:()=>void;onChanged?:()=>void }
export default function AddVideosToPlaylistModal(props: Props): JSX.Element {
  return <PlaylistVideoPicker {...props} subtitle={`${props.videoIds.length} 部`}/>
}
