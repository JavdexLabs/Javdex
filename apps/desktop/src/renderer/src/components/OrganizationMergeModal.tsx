import { Building2 } from 'lucide-react'
import type {
  OrganizationDetail,
  OrganizationMergeOption,
  OrganizationMergeResult,
} from '@shared/classificationTypes'
import { api } from '../api'
import { organizationKeys } from '../query/queryKeys'
import ClassificationMergeModal from './ClassificationMergeModal'
import {
  organizationRoleSummary,
  organizationVideoBreakdown
} from './organizationMergePresentation'
import { UI_ICON_SM } from './iconDefaults'

interface Props {
  target: OrganizationDetail
  onCancel: () => void
  onMerged: (result: OrganizationMergeResult) => void | Promise<void>
}

function organizationMeta(organization: OrganizationDetail | OrganizationMergeOption): string {
  return (
    `${organizationRoleSummary(organization.roles)} · ` +
    `${organizationVideoBreakdown(organization)} · 档案 #${organization.id}`
  )
}

export default function OrganizationMergeModal({
  target,
  onCancel,
  onMerged
}: Props): JSX.Element {
  return (
    <ClassificationMergeModal
      title="合并机构"
      hint="当前机构固定为保留目标。候选包含制作商与发行商，来源关系会完整迁移后删除。"
      entityLabel="机构"
      sourceNoun="一个机构"
      candidateCountUnit="个"
      target={target}
      queryKey={organizationKeys.mergeOptions}
      listCandidates={(search) => api.organizations.mergeOptions(search)}
      merge={(input) => api.organizations.merge(input)}
      renderIcon={() => <Building2 {...UI_ICON_SM} aria-hidden />}
      targetMeta={organizationMeta}
      sourceMeta={organizationMeta}
      candidateMeta={organizationMeta}
      renderPlan={(keep, source) => (
        <>
          <li>保留“{keep.mainName}”作为主名，“{source.mainName}”转为别名</li>
          <li>名称、相关链接与制作商/发行商角色去重合并，目标已有资料优先</li>
          <li>来源两类影片、直接子机构与所属系列全部转移到目标</li>
          <li>系列名称作用域或机构层级冲突会阻止整次合并</li>
          <li>目标没有正式品牌图时才接收来源品牌图，来源记录永久删除</li>
        </>
      )}
      onCancel={onCancel}
      onMerged={onMerged}
    />
  )
}
