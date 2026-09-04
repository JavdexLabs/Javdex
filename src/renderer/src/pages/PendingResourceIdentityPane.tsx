import { useState } from 'react'
import type {
  PendingResourceIdentity,
  PendingResourceIdentityChoice
} from '@shared/libraryTypes'
import { api } from '../api'
import Button from '../components/Button'
import { useToast } from '../components/Toast'
import {
  PendingConfirmBar,
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
      eyebrow={`扫描资源身份 · ${libraryName ?? `媒体库 #${identity.libraryId}`}`}
      title={`「${identity.displayName}」应采用哪个番号？`}
      description="文件名与本地 NFO 给出了不同身份。确认前不会创建影片、资源或媒体库成员。"
      status="待确认"
      statusTone="waiting"
      confirm={
        <PendingConfirmBar
          summary="只能采用扫描时保存的两份身份依据"
          scope="确认后会重新校验源文件；不能在此输入其它番号"
        >
          <Button size="sm" disabled={busy != null} onClick={() => void resolve('discard')}>
            {busy === 'discard' ? '丢弃中…' : '丢弃待办'}
          </Button>
          <Button size="sm" disabled={busy != null} onClick={() => void resolve('filename')}>
            {busy === 'filename' ? '确认中…' : '采用文件名番号'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy != null}
            onClick={() => void resolve('nfo')}
          >
            {busy === 'nfo' ? '确认中…' : '采用 NFO 番号'}
          </Button>
        </PendingConfirmBar>
      }
    >
      <PendingWorkspacePanel>
        <PendingStep step={1} title="比较两份身份依据" hint="候选不可编辑">
          <PendingImpactPanel>
            <PendingImpactList>
              <PendingImpactPair label="文件名番号" value={identity.filenameCode} />
              <PendingImpactPair label="NFO 番号" value={identity.nfoCode} />
              <PendingImpactPair label="资源" value={identity.displayName} />
              {identity.targetDisplay ? (
                <PendingImpactPair label="STRM 目标" value={identity.targetDisplay} />
              ) : null}
            </PendingImpactList>
            <PendingImpactNote>
              确认时会重新授权并核对源文件指纹。只有当前 NFO 仍安全可读且番号与所选身份一致，才会顺带导入元数据。
            </PendingImpactNote>
          </PendingImpactPanel>
        </PendingStep>
      </PendingWorkspacePanel>
    </PendingWorkspace>
  )
}
