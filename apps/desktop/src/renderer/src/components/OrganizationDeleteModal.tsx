import type { ReactNode } from 'react'
import type {
  OrganizationDeleteImpact,
  OrganizationDeleteResult,
  OrganizationRole,
  OrganizationRoleRemovalImpact,
  OrganizationRoleRemovalResult
} from '@shared/classificationTypes'
import { FACET_LABEL } from '../facet'
import { usePreviewCommand } from '../hooks/usePreviewCommand'
import Modal from './Modal'

interface CommonProps {
  organizationName: string
  onCancel: () => void
}

interface RoleRemovalProps extends CommonProps {
  mode: 'role'
  role: OrganizationRole
  loadImpact: () => Promise<OrganizationRoleRemovalImpact>
  remove: () => Promise<OrganizationRoleRemovalResult>
  onCompleted: (result: OrganizationRoleRemovalResult) => void | Promise<void>
}

interface OrganizationDeletionProps extends CommonProps {
  mode: 'organization'
  loadImpact: () => Promise<OrganizationDeleteImpact>
  remove: () => Promise<OrganizationDeleteResult>
  onCompleted: (result: OrganizationDeleteResult) => void | Promise<void>
}

type Props = RoleRemovalProps | OrganizationDeletionProps

interface CommandModalProps<TImpact, TResult> {
  title: string
  loadImpact: () => Promise<TImpact>
  command: () => Promise<TResult>
  canExecute?: (impact: TImpact) => boolean
  onCancel: () => void
  onCompleted: (result: TResult) => void | Promise<void>
  completionErrorMessage: string
  renderImpact: (impact: TImpact) => ReactNode
}

function OrganizationCommandModal<TImpact, TResult>({
  title,
  loadImpact,
  command,
  canExecute,
  onCancel,
  onCompleted,
  completionErrorMessage,
  renderImpact
}: CommandModalProps<TImpact, TResult>): JSX.Element {
  const { impact, error, running, execute } = usePreviewCommand({
    loadImpact,
    command,
    canExecute,
    onCompleted,
    completionErrorMessage
  })
  return (
    <Modal
      title={title}
      danger
      busy={running}
      closeDisabled={running}
      confirmText={running ? '处理中…' : title}
      confirmDisabled={!impact || Boolean(impact && canExecute && !canExecute(impact))}
      onCancel={onCancel}
      onConfirm={() => void execute()}
    >
      <div className="classification-delete-confirmation selectable-text">
        {!impact && !error ? <p>正在检查影响范围…</p> : null}
        {impact ? renderImpact(impact) : null}
        {error ? <p className="classification-maintenance-error">{error}</p> : null}
      </div>
    </Modal>
  )
}

function OrganizationRoleRemovalModal({
  role,
  organizationName,
  loadImpact,
  remove,
  onCancel,
  onCompleted
}: RoleRemovalProps): JSX.Element {
  const roleLabel = FACET_LABEL[role]
  const title = `移除${roleLabel}角色`
  return (
    <OrganizationCommandModal
      title={title}
      loadImpact={loadImpact}
      command={remove}
      canExecute={(impact) => impact.canRemove}
      onCancel={onCancel}
      onCompleted={onCompleted}
      completionErrorMessage="机构角色已移除，但页面收尾失败"
      renderImpact={(impact) => (
        <>
          <p>
            确定移除“{organizationName}”的{roleLabel}角色？将解除 {impact.roleVideoCount}{' '}
            部影片的{roleLabel}关联。
          </p>
          {impact.canRemove ? (
            <p className="classification-delete-confirmation__safe">
              其他机构角色、共享机构资料、所属系列和品牌图均会保留。
            </p>
          ) : (
            <p className="classification-maintenance-error">
              这是该机构的最后一个角色，不能单独移除。请取消后使用“完整删除机构”。
            </p>
          )}
        </>
      )}
    />
  )
}

function FullOrganizationDeleteModal({
  organizationName,
  loadImpact,
  remove,
  onCancel,
  onCompleted
}: OrganizationDeletionProps): JSX.Element {
  return (
    <OrganizationCommandModal
      title="完整删除机构"
      loadImpact={loadImpact}
      command={remove}
      onCancel={onCancel}
      onCompleted={onCompleted}
      completionErrorMessage="机构已删除，但页面收尾失败"
      renderImpact={(impact) => (
        <>
          <p>
            确定完整删除机构“{organizationName}”？将解除 {impact.makerVideoCount}{' '}
            部影片的制作商关联和 {impact.publisherVideoCount} 部影片的发行商关联，并让{' '}
            {impact.directChildCount} 个直属子机构变为无上级、{impact.ownedSeriesCount}{' '}
            个所属系列变为未归属。
          </p>
          <p className="classification-delete-confirmation__safe">
            影片、影片资源及其他影片元数据不会被删除。机构资料与品牌图将被永久移除。
          </p>
        </>
      )}
    />
  )
}

export default function OrganizationDeleteModal(props: Props): JSX.Element {
  return props.mode === 'role' ? (
    <OrganizationRoleRemovalModal {...props} />
  ) : (
    <FullOrganizationDeleteModal {...props} />
  )
}
