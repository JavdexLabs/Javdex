import type { CoverSizePreset } from '@shared/settingsTypes'
import { SegmentedControl, SegmentedOption } from './SegmentedControl'
import { useDisplayMode } from './DisplayModeContext'

export const COVER_SIZE_OPTIONS: ReadonlyArray<{
  value: CoverSizePreset
  label: string
  title: string
}> = [
  { value: 'sm', label: '小', title: '小封面' },
  { value: 'md', label: '标准', title: '标准封面' },
  { value: 'lg', label: '大', title: '大封面' },
  { value: 'xl', label: '特大', title: '特大封面' }
]

interface CoverSizeSwitchProps {
  variant?: 'default' | 'toolbar' | 'stretch' | 'subtle'
  value?: CoverSizePreset
  onChange?: (next: CoverSizePreset) => void
}

export default function CoverSizeSwitch({
  variant = 'toolbar',
  value,
  onChange
}: CoverSizeSwitchProps): JSX.Element {
  const { coverSize, persistCoverSize } = useDisplayMode()
  const active = value ?? coverSize

  return (
    <SegmentedControl variant={variant} aria-label="封面大小" title="封面大小">
      {COVER_SIZE_OPTIONS.map((option) => (
        <SegmentedOption
          key={option.value}
          selected={active === option.value}
          title={option.title}
          onClick={() => {
            if (option.value === active) return
            if (onChange) onChange(option.value)
            else void persistCoverSize(option.value)
          }}
        >
          {option.label}
        </SegmentedOption>
      ))}
    </SegmentedControl>
  )
}
