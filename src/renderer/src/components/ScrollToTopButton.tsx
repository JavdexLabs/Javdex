import { ChevronUp } from 'lucide-react'
import IconButton from './IconButton'
import { UI_ICON } from './iconDefaults'

/** Pixels scrolled before showing back-to-top on list surfaces. */
export const SCROLL_TO_TOP_THRESHOLD = 360

interface ScrollToTopButtonProps {
  visible: boolean
  onClick: () => void
}

export default function ScrollToTopButton({
  visible,
  onClick
}: ScrollToTopButtonProps): JSX.Element {
  return (
    <IconButton
      className={`scroll-to-top-btn${visible ? ' scroll-to-top-btn--visible' : ''}`}
      icon={<ChevronUp {...UI_ICON} />}
      label="回到顶部"
      onClick={onClick}
      tabIndex={visible ? 0 : -1}
    />
  )
}
