import type { ActressDeleteImpact, ActressDeleteMode } from '@shared/actressIpcContract'

export type ActressDeleteConfirmationAction =
  | 'ordinary-confirm'
  | 'acknowledge-risk'
  | 'cancel'

export function actressDeleteModeForAction(
  impact: ActressDeleteImpact,
  action: ActressDeleteConfirmationAction
): ActressDeleteMode | null {
  if (action === 'cancel') return null
  if (impact.linkedActressCount > 0) {
    return action === 'acknowledge-risk' ? 'unlink-videos-and-delete' : null
  }
  return action === 'ordinary-confirm' ? 'only-unlinked' : null
}

export interface ActressDeleteConfirmationCopy {
  highRisk: boolean
  confirmText: string
  description: string
}

export function actressDeleteConfirmationCopy(
  impact: ActressDeleteImpact,
  subjectLabel: string
): ActressDeleteConfirmationCopy {
  if (impact.linkedActressCount > 0) {
    return {
      highRisk: true,
      confirmText: '我已了解，仍要删除',
      description: `${subjectLabel}中有 ${impact.linkedActressCount} 位演员关联了 ${impact.affectedVideoCount} 部影片。继续后会解除这些关联并删除演员档案、头像与写真，但不会删除影片资源。`
    }
  }
  return {
    highRisk: false,
    confirmText: '删除',
    description: `${subjectLabel}均未关联影片。删除后会移除演员档案、头像与写真，且无法恢复。`
  }
}
