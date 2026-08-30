import {
  Clapperboard,
  CircleAlert,
  Cloud,
  Film,
  Folder,
  HardDrive,
  House,
  LayoutGrid,
  List,
  ListVideo,
  Send,
  Settings,
  Star,
  UserRound,
  Video,
  type LucideIcon
} from 'lucide-react'
import { NAV_ICON } from './iconDefaults'

const ICONS = {
  home: House,
  library: LayoutGrid,
  film: Film,
  folder: Folder,
  'hard-drive': HardDrive,
  cloud: Cloud,
  star: Star,
  actress: UserRound,
  director: Clapperboard,
  maker: Video,
  publisher: Send,
  series: List,
  playlist: ListVideo,
  settings: Settings,
  pending: CircleAlert
} satisfies Record<string, LucideIcon>

export type NavIconName = keyof typeof ICONS

export function NavIcon({ name }: { name: NavIconName }): JSX.Element {
  const Icon = ICONS[name]
  return <Icon {...NAV_ICON} />
}
