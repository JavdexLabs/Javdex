import { useState } from 'react'
import type {
  PendingResourceIdentity,
  PendingResourceIdentityChoice
} from '@shared/libraryTypes'
import { api } from '../api'
import Button from '../components/Button'
import Modal from '../components/Modal'
import { useToast } from '../components/Toast'
import {
  PendingConfirmBar,
  PendingChoice,
  PendingSecondaryActions,
  PendingImpactList,
  PendingImpactNote,
  PendingImpactPair,
  PendingImpactPanel,
  PendingStep,
  PendingWorkspace,
  PendingWorkspacePanel
} from '../components/PendingDecisionParts'

export default function PendingResourceIdentityPane({
  identity,
  libraryName,
  onResolved
}: {
  identity: PendingResourceIdentity
  libraryName?: string
  onResolved: () => void
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState<PendingResourceIdentityChoice | null>(null)
  const [choice, setChoice] = useState<'filename' | 'nfo' | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const selectedCode =
    choice === 'filename' ? identity.filenameCode : choice === 'nfo' ? identity.nfoCode : null

  const resolve = async (choice: PendingResourceIdentityChoice): Promise<void> => {
    if (busy) return
    setBusy(choice)
    try {
      const result = await api.scan.resolvePendingResourceIdentity(
        identity.libraryId,
        identity.id,
        { expectedRevision: identity.revision, choice }
      )
      const message =
        result.status === 'discarded'
          ? '资源身份待办已丢弃'
          : result.status === 'pending'
            ? '已确认番号，资源转入归属待确认'
            : '资源身份与归属已确认'
      toast.show(
        result.warnings.length > 0 ? `${message}：${result.warnings.join('；')}` : message,
        result.warnings.length > 0 ? 'info' : 'success'
      )
      onResolved()
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <PendingWorkspace
      eyebrow={`扫描资源 · ${libraryName ?? `媒体库 #${identity.libraryId}`}`}
      title={`${identity.displayName} · 确认番号`}
      description="文件名与本地 NFO 的番号不一致，请核对后选择。"
      status={choice ? '可确认' : '待选择'}
      statusTone={choice ? 'ok' : 'waiting'}
      confirm={
        <PendingConfirmBar
          summary={selectedCode ? `将采用 ${selectedCode}` : '请选择这份资源的番号'}
          scope="确认后按媒体库扫描规则导入或继续确认归属"
          secondary={
            <PendingSecondaryActions>
              <Button variant="ghost" disabled={busy != null} onClick={() => setDiscardOpen(true)}>
                丢弃待办
              </Button>
            </PendingSecondaryActions>
          }
        >
          <Button
            variant="primary"
            disabled={!choice || busy != null}
            onClick={() => choice && void resolve(choice)}
          >
            {busy && busy !== 'discard' ? '确认中…' : '确认番号'}
          </Button>
        </PendingConfirmBar>
      }
      overlays={
        discardOpen ? (
          <Modal
            title="丢弃这条待办？"
            hint="将移除本次番号确认记录，源文件会保留。"
            danger
            busy={busy != null}
            confirmText="丢弃待办"
            onCancel={() => setDiscardOpen(false)}
            onConfirm={() => void resolve('discard')}
          >
            <p className="copyable-text">{identity.displayName}</p>
          </Modal>
        ) : null
      }
    >
      <PendingWorkspacePanel>
        <PendingStep step={1} title="选择番号" hint="选择后可预览导入结果">
          <PendingChoice
            name="resource-identity"
            value="filename"
            label="文件名番号"
            detail={identity.filenameCode}
            checked={choice === 'filename'}
            disabled={busy != null}
            onChange={() => setChoice('filename')}
          />
          <PendingChoice
            name="resource-identity"
            value="nfo"
            label="本地 NFO 番号"
            detail={identity.nfoCode}
            checked={choice === 'nfo'}
            disabled={busy != null}
            onChange={() => setChoice('nfo')}
          />
        </PendingStep>
        <PendingStep step={2} title="确认后的影响">
          <PendingImpactPanel>
            <PendingImpactList>
              <PendingImpactPair label="采用番号" value={selectedCode ?? '等待选择'} />
              <PendingImpactPair label="资源" value={identity.displayName} />
              {identity.targetDisplay ? (
                <PendingImpactPair label="STRM 目标" value={identity.targetDisplay} />
              ) : null}
            </PendingImpactList>
            <PendingImpactNote>
              番号一致且可读取的本地 NFO 将随资源导入；同番号资源按当前媒体库规则处理。
            </PendingImpactNote>
          </PendingImpactPanel>
        </PendingStep>
      </PendingWorkspacePanel>
    </PendingWorkspace>
  )
}
