import Checkbox from './Checkbox'
import type { VideoResourceFilter } from '@shared/videoTypes'
import { VIDEO_RESOURCE_FILTER_ORDER } from '../listView/listQueryParams'
import { VIDEO_RESOURCE_FILTER_LABELS } from './videoResourcePresentation'
import styles from './VideoResourceFilterFieldset.module.css'

interface VideoResourceFilterFieldsetProps {
  value: VideoResourceFilter[]
  onChange: (value: VideoResourceFilter[]) => void
}

/** Shared resource-kind OR filter used by library and playlist surfaces. */
export default function VideoResourceFilterFieldset({
  value,
  onChange
}: VideoResourceFilterFieldsetProps): JSX.Element {
  return (
    <fieldset className={styles.root}>
      <legend className={styles.label}>资源类型</legend>
      <div className={styles.grid}>
        {VIDEO_RESOURCE_FILTER_ORDER.map((kind) => {
          const checked = value.includes(kind)
          return (
            <label key={kind} className={styles.option} data-selected={checked}>
              <Checkbox
                checked={checked}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? VIDEO_RESOURCE_FILTER_ORDER.filter(
                          (candidate) => candidate === kind || value.includes(candidate)
                        )
                      : value.filter((candidate) => candidate !== kind)
                  )
                }
              />
              <span>{VIDEO_RESOURCE_FILTER_LABELS[kind]}</span>
            </label>
          )
        })}
      </div>
      <span className={styles.hint}>多选条件满足任一即可</span>
    </fieldset>
  )
}
