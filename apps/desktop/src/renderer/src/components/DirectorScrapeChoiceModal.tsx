import { useState } from 'react'
import type { VideoDirectorChoiceRequired } from '@shared/videoScrapeTypes'
import Modal from './Modal'
import { ClassificationChoiceList, ClassificationChoiceRow } from './ClassificationChoices'

interface Props {
  choice: VideoDirectorChoiceRequired
  busy?: boolean
  onCancel: () => void
  onChoose: (directorId: number) => void
}

export default function DirectorScrapeChoiceModal({
  choice,
  busy = false,
  onCancel,
  onChoose
}: Props): JSX.Element {
  const [selectedId, setSelectedId] = useState<number | null>(null)

  return (
    <Modal
      title="选择导演"
      hint={`刮削名称“${choice.scrapedName}”匹配到多个导演。请选择正确资料后继续。`}
      size="sm"
      confirmText="应用所选导演"
      confirmDisabled={selectedId == null}
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => {
        if (selectedId != null) onChoose(selectedId)
      }}
    >
      <ClassificationChoiceList
        role="radiogroup"
        aria-label="导演候选"
      >
        {choice.candidates.map((candidate, index) => {
          const selected = candidate.id === selectedId
          const aliases = candidate.aliases.length > 0
            ? `别名：${candidate.aliases.join('、')}`
            : '无别名'
          return (
            <ClassificationChoiceRow
              key={candidate.id}
              role="radio"
              selected={selected}
              name={candidate.mainName}
              description={aliases}
              extraDescription={candidate.description}
              autoFocus={index === 0}
              disabled={busy}
              onClick={() => setSelectedId(candidate.id)}
            />
          )
        })}
      </ClassificationChoiceList>
    </Modal>
  )
}
