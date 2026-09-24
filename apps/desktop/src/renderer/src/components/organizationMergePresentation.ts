import type {
  OrganizationMergeResult,
  OrganizationRole
} from '@shared/classificationTypes'

const ROLE_LABEL: Record<OrganizationRole, string> = {
  maker: '制作商',
  publisher: '发行商'
}

export function organizationRoleSummary(roles: readonly OrganizationRole[]): string {
  return roles.map((role) => ROLE_LABEL[role]).join(' / ') || '未登记角色'
}

export function organizationVideoBreakdown(
  organization: { makerVideoCount: number; publisherVideoCount: number }
): string {
  return `制作 ${organization.makerVideoCount} 部 · 发行 ${organization.publisherVideoCount} 部`
}

export function organizationMergeSuccessMessage(result: OrganizationMergeResult): string {
  return (
    `机构已合并：制作商影片 ${result.transferredMakerVideoCount} 部，` +
    `发行商影片 ${result.transferredPublisherVideoCount} 部，` +
    `子机构 ${result.transferredChildCount} 个，系列 ${result.transferredSeriesCount} 个`
  )
}
