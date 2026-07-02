import {
  Clapperboard,
  LayoutGrid,
  List,
  ListVideo,
  Send,
  Settings,
  UserRound,
  Video,
  type LucideIcon
} from 'lucide-react'
import { NAV_ICON } from './iconDefaults'

const ICONS = {
  library: LayoutGrid,
  actress: UserRound,
  director: Clapperboard,
  maker: Video,
  publisher: Send,
  series: List,
  playlist: ListVideo,
  settings: Settings
} satisfies Record<string, LucideIcon>

export type NavIconName = keyof typeof ICONS

export function NavIcon({ name }: { name: NavIconName }): JSX.Element {
  const Icon = ICONS[name]
  return <Icon {...NAV_ICON} />
}
