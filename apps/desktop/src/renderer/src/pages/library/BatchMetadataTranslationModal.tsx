import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { TRANSLATION_BATCH_MAX_VIDEOS } from '@shared/desktop/metadataTranslationTasks'
import { METADATA_TRANSLATION_FIELDS, type MetadataTranslationField } from '@shared/metadataTranslation'
import Checkbox from '../../../../../../../packages/ui/src/Checkbox'
import { api } from '../../api'
import Button from '../../components/Button'
import { AppFormChoiceGroup } from '../../components/FormPrimitives'
import Modal from '../../components/Modal'
import Switch from '../../components/Switch'
import { useToast } from '../../components/Toast'
import { modelUsageLocation } from '../../settings/settingsRoutes'
import { translationDirectApplyDescription, translationFieldLabel, translationModelLocation, TRANSLATION_TASKS_KEY } from '../../tasks/translationTaskState'
import styles from './BatchMetadataTranslationModal.module.css'

export default function BatchMetadataTranslationModal({ libraryId, libraryName, videoIds, onClose }: {
  libraryId: number
  libraryName: string
  videoIds: number[]
  onClose: () => void
}): JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToast()
  const model = useQuery({ queryKey: ['metadata-translation-model'], queryFn: () => api.metadataTranslation.model(), retry: false })
  const [fields, setFields] = useState<readonly MetadataTranslationField[]>(METADATA_TRANSLATION_FIELDS)
  const [directApply, setDirectApply] = useState(false)
  const tooMany = videoIds.length > TRANSLATION_BATCH_MAX_VIDEOS

  return createPortal(<Modal title="批量翻译元数据" subtitle={`${videoIds.length} 部影片`} size="md" layout="form"
    className={styles.dialog} confirmText="开始后台翻译" onCancel={onClose}
    confirmDisabled={!fields.length || !model.data || model.isError || model.isFetching || tooMany}
    onConfirm={async () => {
      if (!model.data) return
      const { taskId, duplicates, unavailable } = await api.metadataTranslation.start({
        libraryId, videoIds, fields: [...fields], directApply, modelToken: model.data.token
      })
      const message = [taskId ? '翻译任务提交成功' : '本次未创建新任务']
      if (duplicates > 0) message.push(`${duplicates} 个字段已有任务或待确认译文`)
      if (unavailable > 0) message.push(`${unavailable} 部影片已不在来源媒体库`)
      void queryClient.invalidateQueries({ queryKey: TRANSLATION_TASKS_KEY })
      onClose()
      toast.show(`${message.join('。')}。`, taskId ? 'success' : 'info')
    }}>
    <div className={styles.form}>
      <dl className={styles.context}>
        <dt>来源媒体库</dt><dd>{libraryName}</dd>
        <dt>翻译模型</dt><dd>
          {model.isError ? <span role="alert">{model.error.message}</span> : model.data
            ? `${model.data.name} · ${translationModelLocation[model.data.location]}` : '正在读取…'}
          {model.isError && <div className={styles.links}><Link draggable={false} to={modelUsageLocation('', 'text-translation')} onClick={onClose}>翻译模型设置</Link>
            <Button size="sm" onClick={() => void model.refetch()}>重新读取</Button></div>}
        </dd>
      </dl>
      {model.data?.location === 'cloud' && <p className={styles.note}>所选字段的原文会发送到该云端服务。</p>}
      <AppFormChoiceGroup label="翻译字段">
        <div className={styles.choices}>
          {METADATA_TRANSLATION_FIELDS.map(field => <label key={field}>
            <Checkbox checked={fields.includes(field)} onChange={event => {
              const checked = event.target.checked
              setFields(previous => METADATA_TRANSLATION_FIELDS.filter(value => value === field ? checked : previous.includes(value)))
            }} />{translationFieldLabel[field]}
          </label>)}
        </div>
      </AppFormChoiceGroup>
      <label className={styles.direct}>
        <span><strong>翻译后直接应用</strong>
          <small>{translationDirectApplyDescription}</small>
        </span>
        <Switch checked={directApply} onChange={event => setDirectApply(event.target.checked)}
          aria-label="翻译后直接应用" aria-description={translationDirectApplyDescription} />
      </label>
      {tooMany && <p role="alert">每批最多处理 {TRANSLATION_BATCH_MAX_VIDEOS} 部影片，请分批提交。</p>}
    </div>
  </Modal>, document.body)
}
